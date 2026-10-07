import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	DynamicBorder,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	Container,
	Key,
	SelectList,
	Text,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
	visibleWidth,
	type SelectItem,
} from "@earendil-works/pi-tui";

import {
    addUsage,
    emptyUsage,
    entryArray,
    parentSessionIdFromEntries,
	subagentReportIdsFromEntries,
    usageFromSession,
    sessionEntries,
    SUBAGENT_OWNER_CUSTOM_TYPE,
    usageFromEntries,
    type UsageTotals,
} from "./session-data.ts";
import { subagentToolResult } from "./tool-result.ts";
import { resolveModelReference } from "./model-resolution.ts";
import { ReportGate, waitForChildrenToSettle } from "./report-gate.ts";
import { displaySessionId, shortSessionId, uniqueShortSessionId } from "./session-id.ts";
import { selectOwnedSession } from "./session-selection.ts";
import { formatReportBatch } from "./report-format.ts";
import { childSettings } from "./child-settings.ts";
import { ApprovalGate } from "./approval-gate.ts";
import { OneShotDrain } from "./one-shot-drain.ts";
import { terminalReport } from "./terminal-report.ts";
import { collectWaitReports } from "./wait-result.ts";
import { shouldRequestProgress } from "./progress-watchdog.ts";
import { awaitStopOrAbort, stopAgentSession, waitForStopOrTimeout } from "./stop-session.ts";
const EXTENSION_PATH = fileURLToPath(import.meta.url);
const SHUTDOWN_STOP_TIMEOUT_MS = 5_000;
const EXTENSION_NAME = "subagent";
const MAX_REPORT_TEXT = 12_000;
const DEFAULT_CONFIG: SubagentConfig = {
	maxActive: 10,
	progressTimeoutMs: 60_000,
	progressTokenThreshold: 30_000,
	progressMinTurns: 5,
	progressRequestCooldownMs: 300_000,
	reportBatchWindowMs: 300,
	maxReportCharacters: MAX_REPORT_TEXT,
	allowExpensiveModels: false,
	childTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
};

const CHILD_INSTRUCTIONS = `
You are a subagent managed by a foreground Pi agent.

Work only on the task assigned by the coordinator. Be concise. At the end of each meaningful turn, report useful findings, decisions, blockers, and the next step. Do not dump tool transcripts. Do not reveal hidden reasoning. Ask for clarification when the coordinator's instructions are unclear. You cannot spawn or manage other subagents.
`;

type AgentStatus = "running" | "stopping" | "done" | "stopped" | "error";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

type SubagentConfig = {
	maxActive: number;
	progressTimeoutMs: number;
	progressTokenThreshold: number;
	progressMinTurns: number;
	progressRequestCooldownMs: number;
	reportBatchWindowMs: number;
	maxReportCharacters: number;
	allowExpensiveModels: boolean;
	childTools: string[];
};

type SubagentRecord = {
    id: string;
    shortId: string;
    name: string;
    task?: string;
    instructionCount: number;
	reportCount: number;
	reportCountAtRunStart: number;
	waitedReportCount: number;
	errorReported: boolean;
    cwd: string;
    parentSessionId: string;
    session: AgentSession;
    sessionFile: string;
    model?: Model<any>;
    thinkingLevel: ThinkingLevel;
    status: AgentStatus;
    createdAt: number;
    startedAt?: number;
    lastTurnStartedAt?: number;
    turnStartingTokens?: number;
	turnCount: number;
	lastReportTurn: number;
	lastWatchdogTurn: number;
	progressPending: boolean;
    lastWatchdogAt?: number;
    lastReportAt?: number;
    watchdogTimer?: ReturnType<typeof setInterval>;
    lastError?: string;
    lastReport?: string;
	lastQueuedReport?: string;
	stopRequested: boolean;
	stopPromise?: Promise<number>;
	promptPromise?: Promise<void>;
	promptState: "idle" | "preflight" | "running" | "settled";
    unsubscribe: () => void;
};

type StoredSession = {
    id: string;
    path: string;
    name?: string;
    cwd: string;
    parentSessionId?: string;
	savedModel?: { provider: string; id: string };
	savedThinking?: ThinkingLevel;
    modified: Date;
    messageCount: number;
    usage: UsageTotals;
	task?: string;
	lastReport?: string;
};

type Report = {
	agent: SubagentRecord;
	text: string;
};


type WaitOutcome = { text: string; reportAgentIds: string[] };

type TranscriptBlock = {
	kind: "user" | "assistant" | "thinking" | "toolCall" | "toolResult" | "custom";
	label: string;
	content: string;
	summary?: string;
};

const ACTIONS = StringEnum(["start", "message", "status", "stop", "wait"] as const, {
	description: "start creates a new child or resumes a saved child when id is supplied; message queues a follow-up to an active child; status, stop, and wait inspect or manage sessions.",
});
const THINKING_LEVELS = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, {
	description: "Thinking level override for a new or resumed subagent",
});

const SubagentParams = Type.Object({
	action: ACTIONS,
	id: Type.Optional(Type.String({ description: "Session ID for targeting an existing child. Omit to create a new child with start. Supply a saved session ID to resume it with start; message only targets an active child." })),
	task: Type.Optional(Type.String({ description: "Instruction sent when action=start creates or resumes a child. To continue a completed/saved session, use action=start with its id and put the new instruction here; do not use message. If omitted, no instruction is sent." })),
	message: Type.Optional(Type.String({ description: "Follow-up instruction for action=message. Queues work only to an active child; it does not resume a completed or saved session." })),
	name: Type.Optional(Type.String({ description: "Short display name for a new subagent" })),
	model: Type.Optional(Type.String({ description: "Optional provider/model override" })),
	wait: Type.Optional(Type.Boolean({ description: "For start with a task, wait until the child fully finishes (default true); set false for non-final launches, then use action=wait." })),
	thinking: Type.Optional(THINKING_LEVELS),
});

type SubagentInput = {
	action: "start" | "message" | "status" | "stop";
	id?: string;
	task?: string;
	message?: string;
	name?: string;
	model?: string;
	thinking?: ThinkingLevel;
	wait?: boolean;
};

function now(): number {
	return Date.now();
}

function readJsonObject(filePath: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function asPositiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function loadConfig(): SubagentConfig {
	const extensionConfig = readJsonObject(path.join(path.dirname(EXTENSION_PATH), "config.json"));
	const dedicatedConfig = readJsonObject(path.join(getAgentDir(), "subagents.json"));
	const merged = { ...extensionConfig, ...dedicatedConfig };
	const childTools = Array.isArray(merged.childTools)
		? merged.childTools.filter((value): value is string => typeof value === "string" && value !== EXTENSION_NAME)
		: DEFAULT_CONFIG.childTools;
	return {
		maxActive: Math.max(1, Math.floor(asPositiveNumber(merged.maxActive, DEFAULT_CONFIG.maxActive))),
		progressTimeoutMs: asPositiveNumber(merged.progressTimeoutMs, DEFAULT_CONFIG.progressTimeoutMs),
		progressTokenThreshold: asPositiveNumber(merged.progressTokenThreshold, DEFAULT_CONFIG.progressTokenThreshold),
		progressMinTurns: Math.floor(asPositiveNumber(merged.progressMinTurns, DEFAULT_CONFIG.progressMinTurns)),
		progressRequestCooldownMs: asPositiveNumber(
			merged.progressRequestCooldownMs,
			DEFAULT_CONFIG.progressRequestCooldownMs,
		),
		reportBatchWindowMs: asPositiveNumber(merged.reportBatchWindowMs, DEFAULT_CONFIG.reportBatchWindowMs),
		maxReportCharacters: Math.max(
			1000,
			Math.floor(asPositiveNumber(merged.maxReportCharacters, DEFAULT_CONFIG.maxReportCharacters)),
		),
		allowExpensiveModels: merged.allowExpensiveModels === true,
		childTools: childTools.length > 0 ? childTools : DEFAULT_CONFIG.childTools,
	};
}

function encodeProject(cwd: string): string {
	return Buffer.from(cwd, "utf8").toString("base64url");
}

function sessionDirectory(cwd: string): string {
	return path.join(getAgentDir(), "subagents", encodeProject(cwd));
}

function formatTokens(value: number): string {
	if (value < 1000) return String(Math.round(value));
	if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

function formatCost(cost: number): string {
	if (!Number.isFinite(cost) || cost === 0) return "$0.0000";
	if (Math.abs(cost) < 0.0001) return `$${Number(cost.toPrecision(3))}`;
	return `$${cost.toFixed(4)}`;
}

function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.round(milliseconds / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 40))}\n\n[truncated ${value.length - max} characters]`;
}

function preview(value: string | undefined, max = 120): string {
	if (!value) return "";
	const oneLine = value.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
		.map((part) => String((part as { text?: unknown }).text ?? ""))
		.join("\n")
		.trim();
}

function assistantText(message: any): string {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part: any) => part?.type === "text")
		.map((part: any) => String(part.text ?? ""))
		.join("\n")
		.trim();
}

function recordUsage(session: AgentSession): UsageTotals {
	return usageFromSession(session);
}

function modelLabel(model: Model<any> | undefined, thinking: ThinkingLevel): string {
	return `${model ? `${model.provider}/${model.id}` : "default"}:${thinking}`;
}

function modelCost(model: Model<any> | undefined): number[] | undefined {
	const cost = (model as any)?.cost;
	if (!cost || typeof cost !== "object") return undefined;
	return ["input", "output", "cacheRead", "cacheWrite"].map((key) => Number(cost[key] ?? 0));
}

function thinkingRank(level: ThinkingLevel): number {
	return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].indexOf(level);
}

function isMoreExpensive(
	currentModel: Model<any> | undefined,
	candidateModel: Model<any> | undefined,
	currentThinking: ThinkingLevel,
	candidateThinking: ThinkingLevel,
): boolean {
	if (thinkingRank(candidateThinking) > thinkingRank(currentThinking)) return true;
	if (!currentModel || !candidateModel) return candidateModel !== currentModel || candidateThinking !== currentThinking;
	if (currentModel.provider === candidateModel.provider && currentModel.id === candidateModel.id) return false;
	const currentCost = modelCost(currentModel);
	const candidateCost = modelCost(candidateModel);
	if (!currentCost || !candidateCost) return true;
	return candidateCost.some((value, index) => value > currentCost[index] + Number.EPSILON);
}

function getModelOverride(ctx: ExtensionContext, specification: string): Model<any> | undefined {
	const available = ctx.modelRegistry.getAvailable();
	return resolveModelReference(available, specification, ctx.model?.provider) as Model<any> | undefined;
}


function isActive(record: SubagentRecord): boolean {
	return record.status === "running" || record.status === "stopping";
}

function messageForEntry(entry: any): TranscriptBlock[] {
	if (entry.type !== "message") return [];
	const message = entry.message;
	if (!message) return [];
	if (message.role === "user") {
		return [{ kind: "user", label: "USER", content: textFromContent(message.content) }];
	}
	if (message.role === "assistant") {
		const blocks: TranscriptBlock[] = [];
		for (const part of message.content ?? []) {
			if (part.type === "text") blocks.push({ kind: "assistant", label: "ASSISTANT", content: String(part.text ?? "") });
			else if (part.type === "thinking") blocks.push({ kind: "thinking", label: "THINKING", content: String(part.thinking ?? "") });
			else if (part.type === "toolCall") {
				const name = String(part.name ?? "tool");
				blocks.push({
					kind: "toolCall",
					label: "TOOL CALL",
					content: `${name} ${JSON.stringify(part.arguments ?? {})}`,
					summary: name,
				});
			}
		}
		return blocks;
	}
	if (message.role === "toolResult") {
		const toolName = String(message.toolName ?? "tool");
		return [{
			kind: "toolResult",
			label: "TOOL RESULT",
			content: `${toolName}: ${textFromContent(message.content)}`,
			summary: toolName,
		}];
	}
	if (message.role === "custom") {
		return [{ kind: "custom", label: "CUSTOM", content: textFromContent(message.content) }];
	}
	return [];
}

function transcriptSummary(entries: unknown): { task?: string; lastReport?: string } {
	const blocks = entryArray(entries).flatMap((entry) => messageForEntry(entry));
	const task = blocks.find((block) => block.kind === "user" && block.content.trim())?.content;
	const lastReport = [...blocks].reverse().find((block) => block.kind === "assistant" && block.content.trim())?.content;
	return { task: task ? preview(task, 180) : undefined, lastReport: lastReport ? truncate(lastReport, MAX_REPORT_TEXT) : undefined };
}

class SubagentManager {
	private readonly agents = new Map<string, SubagentRecord>();
	private readonly stateListeners = new Set<() => void>();
	private readonly expensiveApprovalGate = new ApprovalGate();
	private pendingReports: Report[] = [];
	private readonly reportGate = new ReportGate();
	private reportTimer?: ReturnType<typeof setTimeout>;
	private mainBusy = false;
	private shuttingDown = false;
	private ui?: ExtensionContext["ui"];
	private mainCwd?: string;
    private mainSessionId?: string;
    private storedSessions: StoredSession[] = [];
	private oneShotMode = false;
	private readonly oneShotDrain = new OneShotDrain();
	private mainContext?: ExtensionContext;
	private summaryPending = false;
	private summaryQueued = false;
	private sendSummary?: () => void;

	setMainContext(ctx: ExtensionContext): void {
		const sessionId = ctx.sessionManager.getSessionId();
		const changed = this.mainCwd !== ctx.cwd || this.mainSessionId !== sessionId;
		this.ui = ctx.ui;
		this.mainCwd = ctx.cwd;
		this.mainSessionId = sessionId;
		this.mainContext = ctx;
		if (changed) {
			this.storedSessions = [];
			void this.loadStoredSessions().catch(() => {
				if (this.mainSessionId === sessionId) this.storedSessions = [];
			});
		}
		this.refreshWidget();
	}

	subscribeState(listener: () => void): () => void {
		this.stateListeners.add(listener);
		return () => this.stateListeners.delete(listener);
	}

	setMainBusy(busy: boolean): void {
		this.mainBusy = busy;
		if (!busy && !this.oneShotMode) this.onMainSettled();
	}

	enableOneShotMode(): void {
		this.oneShotMode = true;
	}

	async onForegroundSettled(): Promise<void> {
		this.setMainBusy(false);
		if (!this.oneShotMode || !this.mainCwd) return;
		await this.oneShotDrain.settle(
			() => this.listActive(this.mainCwd!).length > 0,
			() => this.pendingReports.length > 0 ? this.pendingReports.splice(0) : undefined,
			(reports) => {
				try {
					this.sendMainReport(formatReportBatch(reports), reports);
					this.markReportsDelivered(reports);
				} catch (error) {
					this.pendingReports.unshift(...reports);
					throw error;
				}
			},
		);
	}

	private markReportsDelivered(reports: Report[]): void {
		for (const { agent } of reports) {
			agent.waitedReportCount = Math.max(agent.waitedReportCount, agent.reportCount);
		}
	}


	setSummarySender(sender: () => void): void {
		this.sendSummary = sender;
	}

	private markCompletionIfReady(): void {
        if (this.recordsForContext(this.mainCwd ?? "").length === 0) return;
		if (this.mainCwd && this.listActive(this.mainCwd).length === 0 && !this.summaryPending && !this.summaryQueued) {
			this.summaryPending = true;
		}
	}

	private onMainSettled(): void {
		if (this.pendingReports.length > 0) {
			this.scheduleReportFlush(0);
			return;
		}
		if (this.summaryPending && !this.summaryQueued && this.sendSummary) {
			this.summaryPending = false;
			this.summaryQueued = true;
			this.sendSummary();
			return;
		}
	}

	private config(): SubagentConfig {
		return loadConfig();
	}

    private recordsForContext(cwd: string, parentSessionId = this.mainSessionId): SubagentRecord[] {
        return [...this.agents.values()].filter(
            (agent) => agent.cwd === cwd && (!parentSessionId || agent.parentSessionId === parentSessionId),
        );
    }

    private activeCount(cwd: string): number {
        return this.recordsForContext(cwd).filter(isActive).length;
    }

    private findActive(id: string | undefined, cwd: string): SubagentRecord | undefined {
        if (!id) return undefined;
        const records = this.recordsForContext(cwd);
        const exact = records.filter((agent) => agent.id === id || agent.shortId === id);
        if (exact.length > 0) return exact.length === 1 ? exact[0] : undefined;
        const candidates = records.filter(
            (agent) => agent.id.startsWith(id) || agent.id.endsWith(id),
        );
        return candidates.length === 1 ? candidates[0] : undefined;
    }

    private async readStoredSession(session: Awaited<ReturnType<typeof SessionManager.list>>[number], cwd: string): Promise<StoredSession> {
        const manager = SessionManager.open(session.path);
        const entries = manager.getEntries();
		const saved = manager.buildSessionContext();
		const summary = transcriptSummary(entries);
        return {
            id: session.id,
            path: session.path,
            name: session.name,
            cwd: session.cwd || cwd,
            parentSessionId: parentSessionIdFromEntries(entries),
			savedModel: saved.model ? { provider: saved.model.provider, id: saved.model.modelId } : undefined,
			savedThinking: saved.thinkingLevel as ThinkingLevel | undefined,
			task: summary.task,
			lastReport: summary.lastReport,
            modified: session.modified,
            messageCount: session.messageCount,
            usage: usageFromEntries(entries),
        };
    }

    private async loadStoredSessions(): Promise<void> {
        if (!this.mainCwd || !this.mainSessionId) return;
        const cwd = this.mainCwd;
        const parentSessionId = this.mainSessionId;
        const sessions = await SessionManager.list(cwd, sessionDirectory(cwd));
        const stored = (await Promise.all(sessions.map((session) => this.readStoredSession(session, cwd))))
            .filter((session) => session.parentSessionId === parentSessionId);
        if (this.mainCwd === cwd && this.mainSessionId === parentSessionId) {
            this.storedSessions = stored;
            this.refreshWidget();
        }
    }

    private async resolveStoredSession(id: string, cwd: string): Promise<StoredSession | undefined> {
        const parentSessionId = this.mainSessionId;
        if (!parentSessionId) return undefined;
        const sessions = await this.listStored(cwd, parentSessionId);
        return selectOwnedSession(sessions, id, parentSessionId);
    }

	private async resolveModelAndThinking(
		ctx: ExtensionContext,
		requestedModel: string | undefined,
		requestedThinking: ThinkingLevel | undefined,
		stored?: StoredSession,
	): Promise<{ model: Model<any> | undefined; thinking: ThinkingLevel | undefined }> {
		const requested = requestedModel ? getModelOverride(ctx, requestedModel) : undefined;
		if (requestedModel && !requested) throw new Error(`No available model: ${requestedModel}. Authenticate its provider or use an available provider/model.`);
		const currentThinking = (ctx.thinkingLevel as ThinkingLevel | undefined) ?? "medium";
		const { model, thinking } = childSettings(Boolean(stored), ctx.model, currentThinking, requested, requestedThinking);
		const changed = requestedModel !== undefined || requestedThinking !== undefined;
		const baselineModel = stored ? (stored.savedModel ? ctx.modelRegistry.find(stored.savedModel.provider, stored.savedModel.id) : undefined) : ctx.model;
		const baselineThinking = stored?.savedThinking ?? currentThinking;
		const candidateModel = model ?? baselineModel;
		const candidateThinking = thinking ?? baselineThinking;
		if (changed && isMoreExpensive(baselineModel, candidateModel, baselineThinking, candidateThinking)) {
			const approvalKey = modelLabel(candidateModel, candidateThinking);
			const config = this.config();
			if (!config.allowExpensiveModels) {
				if (!ctx.hasUI) {
					throw new Error(`Potentially more expensive model configuration requires interactive approval: ${approvalKey}`);
				}
				await this.expensiveApprovalGate.ensureApproved(
					approvalKey,
					() => ctx.ui.confirm(
						"Use a more expensive subagent configuration?",
						`${approvalKey}\n\nThe ${stored ? "saved child" : "foreground agent"} currently uses ${modelLabel(baselineModel, baselineThinking)}.`,
					),
					"Subagent model change was not approved.",
				);
			}
		}
		return { model, thinking };
	}

	private async createSession(
		ctx: ExtensionContext,
		params: SubagentInput,
		stored?: StoredSession,
	): Promise<SubagentRecord> {
		const config = this.config();
		if (this.activeCount(ctx.cwd) >= config.maxActive) {
			throw new Error(`Maximum active subagents reached (${config.maxActive}). Stop one before starting another.`);
		}
		const parentSessionId = this.mainSessionId ?? ctx.sessionManager.getSessionId();
		if (stored && stored.parentSessionId !== parentSessionId) {
			throw new Error("Saved subagent belongs to another foreground session.");
		}
		const selected = await this.resolveModelAndThinking(ctx, params.model, params.thinking, stored);
		const manager = stored
			? SessionManager.open(stored.path, sessionDirectory(ctx.cwd), ctx.cwd)
			: SessionManager.create(ctx.cwd, sessionDirectory(ctx.cwd));
		if (!stored) manager.appendCustomEntry(SUBAGENT_OWNER_CUSTOM_TYPE, { parentSessionId });
        const resourceLoader = new DefaultResourceLoader({
            cwd: ctx.cwd,
            agentDir: getAgentDir(),
            noExtensions: true,
            appendSystemPrompt: [CHILD_INSTRUCTIONS],
        });
        await resourceLoader.reload();
        const modelRuntime = await ModelRuntime.create({
            authPath: path.join(getAgentDir(), "auth.json"),
            modelsPath: path.join(getAgentDir(), "models.json"),
            refreshOnCreate: false,
        });
		const emptySavedSession = Boolean(stored && stored.messageCount === 0);
		const savedModel = stored?.savedModel
			? modelRuntime.getModel(stored.savedModel.provider, stored.savedModel.id)
			: undefined;
        const { session, modelFallbackMessage } = await createAgentSession({
            cwd: ctx.cwd,
            agentDir: getAgentDir(),
            model: selected.model ?? (emptySavedSession && !params.model ? savedModel : undefined),
            thinkingLevel: selected.thinking ?? (emptySavedSession ? stored?.savedThinking : undefined),
            tools: config.childTools,
            resourceLoader,
            sessionManager: manager,
            settingsManager: SettingsManager.create(ctx.cwd, getAgentDir()),
            modelRuntime,
        });
		if (stored?.savedModel && !params.model &&
			(session.model?.provider !== stored.savedModel.provider || session.model?.id !== stored.savedModel.id)) {
			session.dispose();
			throw new Error(`Unable to restore saved child model ${stored.savedModel.provider}/${stored.savedModel.id}. ${modelFallbackMessage ?? "Choose an available model override to resume."}`);
		}
        const fullId = session.sessionId;
        const usedShortIds = [
			...[...this.agents.values()].filter((agent) => agent.id !== fullId).map((agent) => agent.shortId),
			...this.storedSessions.filter((saved) => saved.id !== fullId).map((saved) => shortSessionId(saved.id)),
		];
        const shortId = uniqueShortSessionId(fullId, usedShortIds);
        const name = params.name?.trim() || stored?.name || `agent-${shortSessionId(fullId).slice(0, 6)}`;
        if (!stored && name) manager.appendSessionInfo(name);
        if (stored && params.name?.trim()) manager.appendSessionInfo(params.name.trim());
        const record: SubagentRecord = {
            id: fullId,
            shortId,
            name,
            task: params.task?.trim(),
            instructionCount: 0,
			reportCount: 0,
			reportCountAtRunStart: 0,
			waitedReportCount: 0,
			errorReported: false,
            cwd: ctx.cwd,
            parentSessionId,
            session,
			sessionFile: session.sessionFile ?? manager.getSessionFile() ?? stored?.path ?? "",
			model: session.model ?? selected.model,
			thinkingLevel: session.thinkingLevel as ThinkingLevel,
			status: "done",
			createdAt: now(),
			turnCount: 0,
			lastReportTurn: 0,
			lastWatchdogTurn: 0,
			progressPending: false,
			stopRequested: false,
			promptState: "idle",
			unsubscribe: () => {},
		};
		record.unsubscribe = session.subscribe((event: any) => this.handleEvent(record, event));
		this.agents.set(record.id, record);
		this.refreshWidget();
		return record;
	}

	private handleEvent(record: SubagentRecord, event: any): void {
		if (record.stopRequested) {
			if (event.type === "agent_start") {
				record.promptState = "running";
				// A prompt can finish preflight after stop first observed an idle session.
				record.session.clearQueue();
				record.session.abortBash();
				void record.session.abort().catch(() => {});
				return;
			}
			if (event.type === "agent_settled") {
				this.clearWatchdog(record);
				record.promptState = "settled";
				if (!record.stopPromise) record.status = "stopped";
				this.reportGate.release();
				this.oneShotDrain.wake();
				if (!this.shuttingDown) this.refreshWidget();
			}
			return;
		}
		if (this.shuttingDown) return;
		if (event.type === "agent_start") {
			record.status = "running";
			record.promptState = "running";
			record.startedAt ??= now();
			this.refreshWatchdog(record);
			this.refreshWidget();
			return;
		}
		if (event.type === "turn_start") {
			record.status = "running";
			record.turnCount++;
			record.lastTurnStartedAt = now();
			record.turnStartingTokens = recordUsage(record.session).total;
			this.refreshWatchdog(record);
			this.refreshWidget();
			return;
		}
		if (event.type === "turn_end") {
			this.clearWatchdog(record);
			const text = assistantText(event.message);
			if (text) {
				record.lastReport = text;
				record.lastReportAt = now();
				record.lastReportTurn = record.turnCount;
				record.progressPending = false;
				this.queueReport(record, text);
			}
			this.refreshWidget();
			return;
		}
		if (event.type === "agent_settled") {
			this.clearWatchdog(record);
			record.promptState = "settled";
			if (record.status !== "stopped" && record.status !== "error") record.status = "done";
			const diagnostic = terminalReport(record);
			if (diagnostic) {
				if (record.status === "error") record.errorReported = true;
				this.queueReport(record, diagnostic);
			}
			this.reportGate.release();
			this.oneShotDrain.wake();
			this.markCompletionIfReady();
			this.refreshWidget();
			return;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const stopReason = event.message.stopReason;
			if (stopReason === "error") {
				record.status = "error";
				record.lastError = event.message.errorMessage || "Subagent assistant error";
			}
		}
	}

	private refreshWatchdog(record: SubagentRecord): void {
		this.clearWatchdog(record);
		const config = this.config();
		if (config.progressTimeoutMs <= 0 || !record.lastTurnStartedAt) return;
		record.watchdogTimer = setInterval(() => {
			if (record.status !== "running" || !record.session.isStreaming || !record.lastTurnStartedAt) return;
			const elapsed = now() - record.lastTurnStartedAt;
			const tokenDelta = Math.max(0, recordUsage(record.session).total - (record.turnStartingTokens ?? 0));
			const timeoutReached = elapsed >= config.progressTimeoutMs;
			const tokenThresholdReached = config.progressTokenThreshold > 0 && tokenDelta >= config.progressTokenThreshold;
			record.progressPending ||= timeoutReached || tokenThresholdReached;
			const timestamp = now();
			if (!shouldRequestProgress({
				triggerReached: record.progressPending,
				turnCount: record.turnCount,
				lastReportTurn: record.lastReportTurn,
				lastWatchdogTurn: record.lastWatchdogTurn,
				minTurns: config.progressMinTurns,
				lastWatchdogAt: record.lastWatchdogAt,
				now: timestamp,
				cooldownMs: config.progressRequestCooldownMs,
			})) return;
			record.lastWatchdogAt = timestamp;
			record.lastWatchdogTurn = record.turnCount;
			record.progressPending = false;
			void record.session.steer(
				"Please briefly report your current progress, useful findings, blockers, and next step. Continue the task afterward.",
			).catch(() => {
				record.progressPending = true;
				// The turn may settle between the status check and this call.
			});
		}, 1000);
	}

	private clearWatchdog(record: SubagentRecord): void {
		if (record.watchdogTimer) clearInterval(record.watchdogTimer);
		record.watchdogTimer = undefined;
	}

	private queueReport(record: SubagentRecord, text: string): void {
		if (this.shuttingDown) return;
		const config = this.config();
		const clean = text.trim();
		const omitted = "\n[Report truncated; full text is in the saved child transcript.]";
		const capped = clean.length > config.maxReportCharacters
			? clean.slice(0, config.maxReportCharacters - omitted.length) + omitted
			: clean;
		this.pendingReports.push({ agent: record, text: capped });
		record.lastQueuedReport = capped;
		record.reportCount++;
		this.reportGate.release();
		if (this.oneShotMode) return;
		const reportAgentIds = new Set(this.pendingReports.map(({ agent }) => agent.id));
		for (const active of this.recordsForContext(record.cwd, record.parentSessionId).filter(isActive)) reportAgentIds.add(active.id);
		this.scheduleReportFlush(reportAgentIds.size > 1 ? config.reportBatchWindowMs : 0);
	}


	async wait(ctx: ExtensionContext, id?: string, signal?: AbortSignal, includeReports = false): Promise<WaitOutcome> {
		const record = id ? this.findActive(id, ctx.cwd) : undefined;
		if (id && !record) {
			if (!includeReports) throw new Error(`Unknown subagent session: ${id}`);
			const saved = await this.resolveStoredSession(id, ctx.cwd);
			if (!saved) throw new Error(`Unknown subagent session: ${id}`);
			return this.storedWaitResult([saved], "Recovered saved subagent result");
		}
		if (record && !isActive(record) && !includeReports) {
			return { text: `${record.name} (${record.shortId}) is already ${record.status}.`, reportAgentIds: [] };
		}

		const returnReports = (completed: SubagentRecord[], summary: string): WaitOutcome => {
			const { reports, remainingReports } = collectWaitReports(completed, this.pendingReports);
			this.summaryPending = false;
			this.pendingReports = remainingReports;
			for (const agent of completed) agent.waitedReportCount = agent.reportCount;
			const statuses = completed.map((agent) => this.formatRecord(agent)).join("\n");
			const reportText = reports.length > 0
				? `\nReports:\n${formatReportBatch(reports)}`
				: "\nNo new child reports were available.";
			return {
				text: `${summary}:\n${statuses}${reportText}`,
				reportAgentIds: [...new Set(reports.map(({ agent }) => agent.id))],
			};
		};

		const recoverAllCompleted = async (primary: SubagentRecord[], summary: string): Promise<WaitOutcome> => {
			const delivered = subagentReportIdsFromEntries(ctx.sessionManager.getEntries());
			const managed = this.recordsForContext(ctx.cwd);
			const primaryIds = new Set(primary.map((agent) => agent.id));
			const additional = managed.filter(
				(agent) => !primaryIds.has(agent.id) && !isActive(agent) &&
					agent.reportCount > agent.waitedReportCount && !delivered.has(agent.id),
			);
			const completed = [...primary, ...additional];
			const managedIds = new Set(managed.map((agent) => agent.id));
			const saved = (await this.listStored(ctx.cwd)).filter(
				(session) => session.messageCount > 0 && !managedIds.has(session.id) && !delivered.has(session.id),
			);
			const memoryResult = completed.length > 0 ? returnReports(completed, summary) : undefined;
			const savedResult = saved.length > 0 ? this.storedWaitResult(saved, "Recovered saved subagent results") : undefined;
			if (memoryResult && savedResult) {
				return {
					text: `${memoryResult.text}\n\n${savedResult.text}`,
					reportAgentIds: [...new Set([...memoryResult.reportAgentIds, ...savedResult.reportAgentIds])],
				};
			}
			if (memoryResult) return memoryResult;
			if (savedResult) return savedResult;
			return { text: "No running subagents or completed reports to recover.", reportAgentIds: [] };
		};

		if (record && !isActive(record)) {
			return returnReports([record], `${record.name} (${record.shortId}) is already ${record.status}`);
		}

		const records = record ? [record] : this.listActive(ctx.cwd);
		if (records.length === 0) {
			if (!includeReports) return { text: "No running subagents to wait for.", reportAgentIds: [] };
			return recoverAllCompleted([], "No subagents are running; completed results");
		}

		await waitForChildrenToSettle(this.reportGate, () => this.shuttingDown ? [] : records.map((item) => item.status), signal);
		if (includeReports) {
			if (!id) return recoverAllCompleted(records, `Finished waiting for ${records.length} subagent${records.length === 1 ? "" : "s"}`);
			return returnReports(records, `Finished waiting for ${records.length} subagent${records.length === 1 ? "" : "s"}`);
		}
		return {
			text: `Finished waiting for ${records.length} subagent${records.length === 1 ? "" : "s"}:\n${records.map((item) => this.formatRecord(item)).join("\n")}`,
			reportAgentIds: [],
		};
	}

	private storedWaitResult(sessions: StoredSession[], summary: string): WaitOutcome {
		this.summaryPending = false;
		const reports = sessions.map((session) => ({
			agent: { name: session.name || `agent-${shortSessionId(session.id).slice(0, 6)}`, shortId: shortSessionId(session.id) },
			text: session.lastReport?.trim() || `No assistant report was saved for task ${JSON.stringify(session.task ?? "(unknown)")}. Transcript excerpt:\n${this.savedTranscriptExcerpt(session)}`,
		}));
		return {
			text: `${summary}:\n${formatReportBatch(reports)}`,
			reportAgentIds: sessions.map((session) => session.id),
		};
	}

	private savedTranscriptExcerpt(session: StoredSession): string {
		const excerpt = storedTranscript(session)
			.filter((block) => block.kind !== "thinking")
			.map((block) => `${block.label}:\n${block.content}`)
			.filter((block) => block.trim().length > 0)
			.join("\n\n");
		return excerpt ? truncate(excerpt, this.config().maxReportCharacters) : "No visible transcript text was saved.";
	}

	private scheduleReportFlush(delay: number): void {
		if (this.reportTimer) return;
		this.reportTimer = setTimeout(() => {
			this.reportTimer = undefined;
			this.flushReports();
		}, Math.max(0, delay));
	}

	private flushReports(): void {
		if (this.mainBusy || this.pendingReports.length === 0 || this.shuttingDown) return;
		const reports = this.pendingReports.splice(0);
		const content = formatReportBatch(reports);
		try {
			this.sendMainReport(content, reports);
			this.markReportsDelivered(reports);
		} catch {
			this.pendingReports.unshift(...reports);
		}
	}

	private sendMainReport(content: string, reports: Report[]): void {
		// This method is replaced by the extension factory after construction.
		void content;
		void reports;
	}

	setReportSender(sender: (content: string, reports: Report[]) => void): void {
		this.sendMainReport = sender;
	}

	async start(ctx: ExtensionContext, params: SubagentInput): Promise<{ text: string; record: SubagentRecord }> {
		const existing = params.id ? this.findActive(params.id, ctx.cwd) : undefined;
		let record = existing;
		if (!record && params.id) {
			const stored = await this.resolveStoredSession(params.id, ctx.cwd);
			if (!stored) throw new Error(`No active or saved subagent matched "${params.id}". To start a new agent, omit id and provide name/task; use id only to resume an existing session.`);
			record = await this.createSession(ctx, params, stored);
		}
		if (!record) record = await this.createSession(ctx, params);
		if (record.status === "stopping") throw new Error(`Subagent ${record.name} is still stopping; retry start after it settles.`);
		if (record.stopPromise) throw new Error(`Subagent ${record.name} is still stopping; retry start after it settles.`);
		if (record.stopRequested) {
			record.stopRequested = false;
			record.status = "done";
		}
		const instruction = params.task?.trim();
		if (instruction) await this.queueMessage(record, instruction);
		return { text: `Started ${record.name} (${record.shortId})${instruction ? " and queued its task" : ""}.`, record };
	}

	async queueMessage(record: SubagentRecord, message: string): Promise<void> {
		const text = message.trim();
		if (!text) throw new Error("A non-empty message is required.");
		if (record.stopRequested || record.status === "stopping") throw new Error(`Subagent ${record.name} is stopping or stopped; use action=start to resume it.`);

		// A prompt may be in preflight with isStreaming still false, or in its
		// agent_settled callback with isStreaming already false. Serialize those
		// edges so simultaneous messages never start competing session.prompt() calls.
		if (!record.session.isStreaming && record.promptPromise && record.promptState !== "preflight") {
			await record.promptPromise;
		}
		if (record.stopRequested) throw new Error(`Subagent ${record.name} is stopping or stopped; use action=start to resume it.`);

		this.summaryPending = false;
		this.summaryQueued = false;
		record.instructionCount += 1;
		record.reportCountAtRunStart = record.reportCount;
		record.errorReported = false;
		record.lastError = undefined;
		record.lastReportTurn = record.turnCount;
		record.lastWatchdogTurn = record.turnCount;
		record.lastWatchdogAt = undefined;
		record.progressPending = false;
		record.task ??= text;
		record.status = "running";
		record.startedAt ??= now();

		if (record.session.isStreaming || record.promptState === "preflight") {
			await record.session.followUp(text);
		} else {
			record.promptState = "preflight";
			const prompt = record.session.prompt(text, { source: "extension" }).catch((error: unknown) => {
				if (record.stopRequested) return;
				const queued = record.session.clearQueue();
				const discarded = queued.steering.length + queued.followUp.length;
				record.status = "error";
				record.lastError = error instanceof Error ? error.message : String(error);
				if (!record.errorReported) {
					record.errorReported = true;
					const note = discarded > 0 ? ` ${discarded} queued message${discarded === 1 ? " was" : "s were"} discarded because the prompt failed before ${discarded === 1 ? "it ran" : "they ran"}.` : "";
					this.queueReport(record, `Subagent failed: ${record.lastError}.${note}`);
				}
				this.reportGate.release();
				this.oneShotDrain.wake();
				this.markCompletionIfReady();
				this.refreshWidget();
			});
			let trackedPrompt: Promise<void>;
			trackedPrompt = prompt.finally(() => {
				if (record.promptPromise === trackedPrompt) {
					record.promptPromise = undefined;
					record.promptState = "idle";
					if (record.stopRequested && !record.stopPromise && !record.session.isStreaming) {
						record.status = "stopped";
						this.clearWatchdog(record);
						this.reportGate.release();
						this.oneShotDrain.wake();
						if (!this.shuttingDown) this.refreshWidget();
					}
				}
			});
			record.promptPromise = trackedPrompt;
		}
		this.refreshWidget();
	}

	async message(ctx: ExtensionContext, id: string | undefined, message: string | undefined): Promise<string> {
		const record = this.findActive(id, ctx.cwd);
		if (!record) throw new Error(`Unknown active subagent: ${id ?? "(missing id)"}`);
		if (!isActive(record) || record.stopRequested) throw new Error(`Subagent ${record.name} is ${record.status}; use action=start to resume it.`);
		await this.queueMessage(record, message ?? "");
		return `Queued a message for ${record.name} (${record.shortId}).`;
	}

	async stop(ctx: ExtensionContext, id: string | undefined, signal?: AbortSignal): Promise<string> {
		const record = this.findActive(id, ctx.cwd);
		if (!record) throw new Error(`Unknown active subagent: ${id ?? "(missing id)"}`);
		if (record.status === "stopped" && !record.session.isStreaming) return `Subagent ${record.name} (${record.shortId}) is already stopped.`;
		if (!isActive(record) && !record.session.isStreaming && !record.stopPromise) throw new Error(`Unknown active subagent: ${id ?? "(missing id)"}`);

		let stopping = record.stopPromise;
		if (!stopping) {
			record.stopRequested = true;
			record.status = "stopping";
			record.waitedReportCount = record.reportCount;
			record.lastQueuedReport = undefined;
			this.pendingReports = this.pendingReports.filter((report) => report.agent !== record);
			this.clearWatchdog(record);
			if (!this.shuttingDown) this.refreshWidget();
			stopping = stopAgentSession(record.session, () => record.promptPromise);
			record.stopPromise = stopping;
			void stopping.then(
				() => this.finishStop(record, stopping!, true),
				() => this.finishStop(record, stopping!, false),
			);
		}
		const discardedMessages = await awaitStopOrAbort(stopping, signal);
		const dropped = discardedMessages > 0
			? ` Discarded ${discardedMessages} queued message${discardedMessages === 1 ? "" : "s"}.`
			: "";
		return `Stopped ${record.name} (${record.shortId}).${dropped}`;
	}

	private finishStop(record: SubagentRecord, stopping: Promise<number>, succeeded: boolean): void {
		if (record.stopPromise !== stopping) return;
		record.stopPromise = undefined;
		record.status = succeeded ? "stopped" : record.session.isStreaming || record.promptPromise ? "stopping" : "stopped";
		this.clearWatchdog(record);
		this.reportGate.release();
		this.oneShotDrain.wake();
		if (!this.shuttingDown) this.refreshWidget();
	}

	status(ctx: ExtensionContext, id?: string): string {
		const records = id ? [this.findActive(id, ctx.cwd)].filter(Boolean) as SubagentRecord[] : this.listActive(ctx.cwd);
		if (id && records.length === 0) return `No subagent matched ${id}. Use /subagents to inspect saved sessions.`;
		if (records.length === 0) return "No active subagents.";
		return records.map((record) => this.formatRecord(record)).join("\n");
	}

	private formatRecord(record: SubagentRecord): string {
		const stats = recordStats(record);
		const error = record.lastError ? ` error=${truncate(record.lastError, 160)}` : "";
		const task = record.task ? ` task=${JSON.stringify(preview(record.task))}` : "";
		const state = record.stopRequested && record.status !== "stopped" ? "stopping" : record.status;
		return `${record.shortId} ${record.name} ${state} child-turns=${stats.turns} main-messages=${record.instructionCount} ${modelLabel(record.model, record.thinkingLevel)} ${formatDuration(stats.elapsedMs)} ↑${formatTokens(stats.usage.input)} ↓${formatTokens(stats.usage.output)} ${formatCost(stats.usage.cost)}${task}${error}`;
	}

	listActive(cwd: string): SubagentRecord[] {
        return this.recordsForContext(cwd).filter(isActive);
	}

    async listStored(cwd: string, parentSessionId = this.mainSessionId): Promise<StoredSession[]> {
        const sessions = await SessionManager.list(cwd, sessionDirectory(cwd));
        const stored = await Promise.all(sessions.map((session) => this.readStoredSession(session, cwd)));
        return parentSessionId ? stored.filter((session) => session.parentSessionId === parentSessionId) : stored;
    }

    getRecord(id: string, cwd: string): SubagentRecord | undefined {
		const record = this.findActive(id, cwd);
		return record && isActive(record) ? record : undefined;
    }

    async resume(ctx: ExtensionContext, stored: StoredSession, message?: string): Promise<SubagentRecord> {
        const record = await this.createSession(ctx, { action: "start", id: stored.id, task: message }, stored);
        if (message) await this.queueMessage(record, message);
        return record;
    }

	refreshWidget(): void {
		if (this.ui && this.mainCwd) {
			const all = this.recordsForContext(this.mainCwd);
			const childUsage = emptyUsage();
			for (const record of all) addUsage(childUsage, recordUsage(record));
			const activeIds = new Set(all.map((record) => record.id));
			for (const session of this.storedSessions) {
				if (!activeIds.has(session.id)) addUsage(childUsage, session.usage);
			}
			const mainUsage = this.mainContext ? usageFromEntries(this.mainContext.sessionManager.getEntries()) : emptyUsage();
			const combinedCost = mainUsage.cost + childUsage.cost;
			this.ui.setStatus(
				"subagents-cost",
				all.length > 0 || this.storedSessions.length > 0
					? `children ${formatCost(childUsage.cost)} · combined ${formatCost(combinedCost)}`
					: undefined,
			);
			const active = all.filter(isActive);
			if (active.length === 0) {
				this.ui.setWidget("subagents", undefined);
			} else {
				const widgetRows = active.map((record) => {
					const stats = recordStats(record);
					return { name: record.name, stopping: record.stopRequested, elapsed: formatDuration(stats.elapsedMs), cost: stats.usage.cost, task: record.task, model: modelLabel(record.model, record.thinkingLevel) };
				});
				this.ui.setWidget("subagents", (_tui, theme) => ({
					render: (width: number) => widgetRows.map((row) => {
						const state = row.stopping ? theme.fg("warning", "● STOPPING") : theme.fg("success", "● RUNNING");
						const task = preview(row.task, width < 80 ? 24 : 48);
						const model = width >= 100 ? ` · ${row.model}` : "";
						const line = `${state} ${row.name} · ${row.elapsed} · ${formatCost(row.cost)}${model}${task ? ` · ${task}` : ""}`;
						return truncateToWidth(line, Math.max(1, width));
					}),
					invalidate() {},
				}));
			}
		}
		for (const listener of this.stateListeners) {
			try { listener(); } catch { /* A UI subscriber must not disrupt agent lifecycle handling. */ }
		}
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		this.reportGate.release();
		this.oneShotDrain.close();
		if (this.reportTimer) clearTimeout(this.reportTimer);
		const records = [...this.agents.values()];
		this.pendingReports = [];
		await Promise.all(records.map(async (record) => {
			this.clearWatchdog(record);
			record.stopRequested = true;
			try {
				await waitForStopOrTimeout(record.stopPromise ?? stopAgentSession(record.session, () => record.promptPromise), SHUTDOWN_STOP_TIMEOUT_MS);
			} catch {
				// Continue disposing child sessions while Pi is shutting down.
			}
			record.unsubscribe();
			record.session.dispose();
		}));
		this.agents.clear();
		this.stateListeners.clear();
		this.ui?.setWidget("subagents", undefined);
		this.ui?.setStatus("subagents-cost", undefined);
	}
}

function recordStats(record: SubagentRecord): { usage: UsageTotals; turns: number; elapsedMs: number } {
	const usage = recordUsage(record.session);
	const messages = entryArray(record.session.messages);
	const turns = messages.filter((message) => message.role === "assistant").length;
	const lastTimestamp = [...messages]
		.reverse()
		.find((message) => typeof message.timestamp === "number")?.timestamp;
	const end = record.status === "running" || record.status === "stopping" ? now() : Number(lastTimestamp ?? now());
	return { usage, turns, elapsedMs: Math.max(0, end - record.createdAt) };
}

function recordTranscript(record: SubagentRecord): TranscriptBlock[] {
	const entries = sessionEntries(record.session);
	return entries.flatMap((entry) => messageForEntry(entry));
}

function storedTranscript(stored: StoredSession): TranscriptBlock[] {
	try {
		const manager = SessionManager.open(stored.path);
		return entryArray(manager.getEntries()).flatMap((entry: any) => messageForEntry(entry));
	} catch (error) {
		return [{ kind: "custom", label: "ERROR", content: `Unable to open session: ${error instanceof Error ? error.message : String(error)}` }];
	}
}

function transcriptRows(
	blocks: TranscriptBlock[],
	width: number,
	theme: any,
	showThinking: boolean,
	showTools: boolean,
): { rows: string[]; hiddenTools: number } {
	const compactLabels: Record<TranscriptBlock["kind"], string> = {
		user: "USER",
		assistant: "ASSISTANT",
		thinking: "THINKING",
		toolCall: "CALL",
		toolResult: "RESULT",
		custom: "CUSTOM",
	};
	const colors: Record<TranscriptBlock["kind"], "userMessageText" | "accent" | "dim" | "muted" | "toolOutput" | "customMessageText"> = {
		user: "userMessageText",
		assistant: "accent",
		thinking: "dim",
		toolCall: "muted",
		toolResult: "toolOutput",
		custom: "customMessageText",
	};
	const rows: string[] = [];
	let hiddenTools = 0;
	const innerWidth = Math.max(1, width - 4);
	for (const block of blocks) {
		if (block.kind === "thinking" && !showThinking) continue;
		let content = block.content;
		if ((block.kind === "toolCall" || block.kind === "toolResult") && !showTools) {
			hiddenTools++;
			content = block.kind === "toolCall"
				? `${block.summary ?? "tool"} arguments hidden (press o to show)`
				: `${block.summary ?? "tool"} output hidden (press o to show)`;
		}
		const label = `${width < 56 ? compactLabels[block.kind] : block.label}:`;
		const styledLabel = theme.fg(colors[block.kind], label);
		const labelWidth = visibleWidth(label);
		const continuation = " ".repeat(labelWidth + 1);
		for (const [lineIndex, paragraph] of content.split(/\r?\n/).entries()) {
			const firstLine = lineIndex === 0;
			const prefixWidth = firstLine ? labelWidth + 1 : continuation.length;
			const wrapped = paragraph
				? wrapTextWithAnsi(paragraph, Math.max(1, innerWidth - prefixWidth))
				: [""];
			rows.push(firstLine ? `${styledLabel} ${wrapped[0] ?? ""}` : `${continuation}${wrapped[0] ?? ""}`);
			for (const remainder of wrapped.slice(1)) rows.push(`${continuation}${remainder}`);
		}
		rows.push("");
	}
	while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
	return { rows, hiddenTools };
}

async function showTranscript(
	ctx: ExtensionContext,
	title: string,
	blocksSource: () => TranscriptBlock[],
	subscribe?: (listener: () => void) => () => void,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Transcript viewing requires interactive TUI mode.", "warning");
		return;
	}
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		let offset = 0;
		let viewportHeight = 1;
		let followLatest = true;
		let showThinking = false;
		let showTools = false;
		let renderedRows: string[] = [];
		let hiddenTools = 0;
		const render = (width: number): string[] => {
			const availableRows = Math.floor(tui.terminal.rows * 0.8) - 5;
			viewportHeight = Math.max(1, Math.min(40, availableRows));
			const transcript = transcriptRows(blocksSource(), width, theme, showThinking, showTools);
			renderedRows = transcript.rows;
			hiddenTools = transcript.hiddenTools;
			const maxOffset = Math.max(0, renderedRows.length - viewportHeight);
			offset = followLatest ? maxOffset : Math.max(0, Math.min(offset, maxOffset));
			const visible = renderedRows.slice(offset, offset + viewportHeight);
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
			container.addChild(new Text(visible.length > 0 ? visible.join("\n") : theme.fg("dim", "No messages yet."), 1, 0));
			const range = renderedRows.length === 0 ? "0 lines" : `lines ${offset + 1}-${Math.min(offset + visible.length, renderedRows.length)} of ${renderedRows.length}`;
			const toggles = `thinking:${showThinking ? "on" : "off"} · tools:${showTools ? "full" : `${hiddenTools} collapsed`}`;
			container.addChild(new Text(theme.fg("dim", `${range} · ${toggles} · ↑↓/pgup/pgdn scroll · home/end · t/o toggle · esc close`), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			return container.render(width);
		};
		const unsubscribe = subscribe?.(() => tui.requestRender());
		return {
			render,
			handleInput(data: string) {
				const maxOffset = Math.max(0, renderedRows.length - viewportHeight);
				if (matchesKey(data, Key.escape)) done();
				else if (data.toLowerCase() === "t") { showThinking = !showThinking; tui.requestRender(); }
				else if (data.toLowerCase() === "o") { showTools = !showTools; tui.requestRender(); }
				else if (matchesKey(data, Key.up)) { followLatest = false; offset = Math.max(0, offset - 1); tui.requestRender(); }
				else if (matchesKey(data, Key.down)) { offset = Math.min(maxOffset, offset + 1); followLatest = offset === maxOffset; tui.requestRender(); }
				else if (matchesKey(data, Key.pageUp)) { followLatest = false; offset = Math.max(0, offset - viewportHeight); tui.requestRender(); }
				else if (matchesKey(data, Key.pageDown)) { offset = Math.min(maxOffset, offset + viewportHeight); followLatest = offset === maxOffset; tui.requestRender(); }
				else if (matchesKey(data, Key.home)) { offset = 0; followLatest = false; tui.requestRender(); }
				else if (matchesKey(data, Key.end)) { offset = maxOffset; followLatest = true; tui.requestRender(); }
			},
			invalidate() {},
			dispose() { unsubscribe?.(); },
		};
	}, { overlay: true, overlayOptions: { width: "90%", maxHeight: "85%" } });
}

function renderSubagentCall(args: any, theme: any): Text {
	const action = String(args?.action ?? "?");
    const target = args?.id ? ` id=${shortSessionId(String(args.id))}` : "";
	const name = action === "start" && args?.name ? ` name=${String(args.name)}` : "";
	let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `${action}${target}${name}`);
	const instruction = args?.task ?? args?.message;
	if (instruction) text += `\n  ${theme.fg("dim", preview(String(instruction), 180))}`;
	if (args?.model) text += `\n  ${theme.fg("muted", `model: ${args.model}`)}`;
	if (args?.thinking) text += ` ${theme.fg("muted", `thinking: ${args.thinking}`)}`;
	if (args?.wait === false) text += ` ${theme.fg("muted", "wait: false")}`;
	return new Text(text, 0, 0);
}

function renderSubagentResult(result: any, _options: any, theme: any): Text {
	const text = textFromContent(result?.content) || (result?.isError ? "Subagent manager error" : "Done");
	return new Text(theme.fg(result?.isError ? "error" : "toolOutput", text), 0, 0);
}
async function openSubagentsUI(ctx: ExtensionContext, manager: SubagentManager): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(manager.status(ctx), "info");
		return;
	}
	const normalizeId = (value: string | undefined) => value?.startsWith("stored:") ? value.slice("stored:".length) : value;
	let preferredSelection: string | undefined;
	while (true) {
		let stored = await manager.listStored(ctx.cwd);
		let active = manager.listActive(ctx.cwd);
		const itemsFor = (activeRecords: SubagentRecord[], savedSessions: StoredSession[]): SelectItem[] => {
			const storedIds = savedSessions.map((session) => session.id);
			const items: SelectItem[] = [];
			for (const record of [...activeRecords].sort((a, b) => (b.lastReportAt ?? b.createdAt) - (a.lastReportAt ?? a.createdAt))) {
				const stats = recordStats(record);
				const activity = record.lastError ? `error: ${preview(record.lastError, 70)}` : record.lastReport ? `latest: ${preview(record.lastReport, 70)}` : "awaiting first report";
				const details = [
					record.task ? `task: ${preview(record.task, 64)}` : undefined,
					`${stats.turns} turns · ${formatDuration(stats.elapsedMs)} · ${formatCost(stats.usage.cost)}`,
					modelLabel(record.model, record.thinkingLevel),
					activity,
				].filter(Boolean).join(" · ");
				items.push({ value: record.id, label: `${record.stopRequested ? "◌ STOPPING" : "● RUNNING"} ${record.name} (${record.shortId})`, description: details });
			}
			const activeIds = new Set(activeRecords.map((record) => record.id));
			for (const session of [...savedSessions].sort((a, b) => b.modified.getTime() - a.modified.getTime())) {
				if (activeIds.has(session.id)) continue;
				const savedModel = session.savedModel ? `${session.savedModel.provider}/${session.savedModel.id}${session.savedThinking ? `:${session.savedThinking}` : ""}` : "default model";
				const details = [
					session.task ? `task: ${preview(session.task, 64)}` : undefined,
					`updated ${session.modified.toLocaleString()} · ${session.messageCount} messages · ${formatCost(session.usage.cost)}`,
					savedModel,
					session.lastReport ? `latest: ${preview(session.lastReport, 70)}` : undefined,
				].filter(Boolean).join(" · ");
				items.push({
					value: `stored:${session.id}`,
					label: `◷ SAVED ${session.name || `agent-${shortSessionId(session.id).slice(0, 6)}`} (${displaySessionId(session.id, storedIds)})`,
					description: details,
				});
			}
			return items;
		};
		const initialItems = itemsFor(active, stored);
		if (initialItems.length === 0) {
			ctx.ui.notify("No subagent sessions for this project.", "info");
			return;
		}
		const selected = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
			let list: SelectList;
			let container = new Container();
			let disposed = false;
			let refreshSequence = 0;
			let currentItems = initialItems;
			let selection = preferredSelection;
			const makeList = (items: SelectItem[], wanted?: string): SelectList => {
				const next = new SelectList(items, Math.max(1, Math.min(12, tui.terminal.rows - 7)), {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.bg("selectedBg", theme.fg("text", text)),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				});
				const wantedId = normalizeId(wanted);
				const selectedIndex = wanted ? items.findIndex((item) => item.value === wanted || normalizeId(item.value) === wantedId) : -1;
				if (selectedIndex >= 0) next.setSelectedIndex(selectedIndex);
				next.onSelectionChange = (item) => { selection = item.value; };
				next.onSelect = (item) => done(item.value === "__empty" ? undefined : item.value);
				next.onCancel = () => done(undefined);
				return next;
			};
			const rebuildContainer = () => {
				container = new Container();
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Subagents")), 1, 0));
				container.addChild(new Text(theme.fg("dim", `${active.length} running · ${stored.filter((item) => !active.some((record) => record.id === item.id)).length} saved · list refreshes live`), 1, 0));
				container.addChild(list);
				container.addChild(new Text(theme.fg("dim", "↑↓ move · enter actions · esc close"), 1, 0));
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			};
			if (currentItems.length === 0) currentItems = [{ value: "__empty", label: "No sessions found", description: "Sessions may have been removed." }];
			list = makeList(currentItems, selection);
			rebuildContainer();
			let liveTimer: ReturnType<typeof setInterval> | undefined;
			const updateRows = (nextActive: SubagentRecord[]) => {
				active = nextActive;
				currentItems = itemsFor(active, stored);
				if (currentItems.length === 0) currentItems = [{ value: "__empty", label: "No sessions found", description: "Sessions may have been removed." }];
				const wanted = list.getSelectedItem()?.value ?? selection ?? preferredSelection;
				list = makeList(currentItems, wanted);
				rebuildContainer();
				tui.requestRender();
				if (active.length === 0 && liveTimer) { clearInterval(liveTimer); liveTimer = undefined; }
			};
			const refresh = async () => {
				const sequence = ++refreshSequence;
				try {
					const [nextStored, nextActive] = await Promise.all([manager.listStored(ctx.cwd), Promise.resolve(manager.listActive(ctx.cwd))]);
					if (disposed || sequence !== refreshSequence) return;
					stored = nextStored;
					updateRows(nextActive);
				} catch {
					// Keep the last rendered list if a saved session is temporarily unavailable.
				}
			};
			if (active.length > 0) {
				liveTimer = setInterval(() => { if (!disposed) updateRows(manager.listActive(ctx.cwd)); }, 1000);
				liveTimer.unref?.();
			}
			const unsubscribe = manager.subscribeState(() => { void refresh(); });
			return {
				render: (width: number) => container.render(width),
				handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); },
				invalidate: () => container.invalidate(),
				dispose: () => { disposed = true; refreshSequence++; if (liveTimer) clearInterval(liveTimer); unsubscribe(); },
			};
		}, { overlay: true, overlayOptions: { width: "90%", maxHeight: "80%" } });
		if (!selected) return;
		preferredSelection = selected;
		const storedSelection = selected.startsWith("stored:");
		const id = storedSelection ? selected.slice("stored:".length) : selected;
		const record = manager.getRecord(id, ctx.cwd);
		const old = stored.find((session) => session.id === id);
		const name = record?.name || old?.name || shortSessionId(id);
		const actions: SelectItem[] = [{ value: "view", label: "View transcript  [v]" }];
		if (record) {
			actions.push({ value: "message", label: "Send queued message  [m]" });
			actions.push({ value: "stop", label: "Stop agent  [s]" });
		} else if (old) {
			actions.push({ value: "resume", label: "Resume session  [r]" });
		}
		actions.push({ value: "back", label: "Back  [b]" });
		const action = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
			const list = new SelectList(actions, Math.max(1, Math.min(actions.length, tui.terminal.rows - 6)), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.bg("selectedBg", theme.fg("text", text)),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold(`${name} · actions`)), 1, 0));
			container.addChild(list);
			container.addChild(new Text(theme.fg("dim", "enter select · shortcut key · esc back"), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			return {
				render: (width: number) => container.render(width),
				handleInput(data: string) {
					const shortcut = data.length === 1 ? data.toLowerCase() : "";
					const choice = actions.find((item) => item.label.match(/\[([a-z])\]$/i)?.[1]?.toLowerCase() === shortcut);
					if (choice) done(choice.value);
					else { list.handleInput(data); tui.requestRender(); }
				},
				invalidate: () => container.invalidate(),
			};
		}, { overlay: true, overlayOptions: { width: "60%", maxHeight: "70%" } });
		if (!action || action === "back") continue;
		if (action === "view") {
			if (record) await showTranscript(ctx, `${record.name} (${record.shortId})`, () => recordTranscript(record), (listener) => manager.subscribeState(listener));
			else if (old) await showTranscript(ctx, `${old.name || shortSessionId(old.id)} (${shortSessionId(old.id)})`, () => storedTranscript(old));
			continue;
		}
		if (action === "message" && record) {
			const message = await ctx.ui.editor("Queue a message for the subagent");
			if (message?.trim()) {
				try { await manager.message(ctx, record.id, message); ctx.ui.notify("Message queued.", "info"); }
				catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
			}
			continue;
		}
		if (action === "stop" && record) {
			if (await ctx.ui.confirm("Stop subagent?", `${record.name} (${record.shortId})`)) {
				try { await manager.stop(ctx, record.id); ctx.ui.notify("Subagent stopped.", "info"); }
				catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
			}
			continue;
		}
		if (action === "resume" && old) {
			const message = await ctx.ui.editor("Optional instruction for the resumed subagent");
			try {
				await manager.resume(ctx, old, message?.trim() || undefined);
				ctx.ui.notify("Subagent resumed.", "info");
			} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
		}
	}
}

export default function (pi: ExtensionAPI) {
	const manager = new SubagentManager();

	pi.on("session_start", (_event, ctx) => {
		manager.setMainContext(ctx);
	});
	pi.on("agent_start", () => manager.setMainBusy(true));
	pi.on("agent_settled", async () => manager.onForegroundSettled());
	pi.on("session_shutdown", async () => manager.shutdown());

	manager.setReportSender((content, reports) => {
		pi.sendMessage(
			{
				customType: "subagent-report",
				content,
				display: true,
				details: { agents: reports.map(({ agent }) => agent.id) },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});
	manager.setSummarySender(() => {
		pi.sendMessage(
			{
				customType: "subagent-summary-request",
				content: "All subagent work is complete. Review the participant reports above. When useful, provide a concise user-facing summary; it may cover the work, decisions, commits, validation, and limitations. Do not call subagent tools unless a genuine follow-up is needed.",
				display: false,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});

	pi.registerCommand("subagents", {
		description: "View and control active or saved subagent sessions",
		handler: async (args, ctx) => {
			if (args.trim().toLowerCase() === "help") {
				ctx.ui.notify("/subagents lists active and saved child sessions. Select one, then view its transcript, queue a user message, stop it, or resume it. Esc closes the viewer.", "info");
				return;
			}
			await openSubagentsUI(ctx, manager);
		},
	});

	pi.registerTool({
		name: EXTENSION_NAME,
		label: "Subagents",
		promptSnippet: "Start, message, wait for, inspect, or stop persistent subagents",
		promptGuidelines: [
			"Use subagent only when the user explicitly asks for subagents or delegation.",
			"For a new agent, call action=start without id. Use name for its display name; never put an issue number, task key, or name in id.",
			"To resume a saved/completed child, call action=start with its id and put the new instruction in task. Do not use action=message for a completed child; message only queues work to an active child. Omit id when creating a new child.",
			"If a start call reports no matching session, retry once without id rather than inventing or changing session IDs.",
			"A start call with a task waits until that child fully finishes by default. Set wait=false only for non-final launches; after starting work non-blocking, call action=wait before continuing with unrelated work or giving a final answer. Do not use bash sleep or status polling.",
			"Use action=wait to block until one or all active children finish. It returns their reports and continues the foreground LLM turn; an unscoped wait also recovers unreported completed/saved results from this foreground session, including a bounded transcript excerpt when no assistant report exists. Parallel starts can wait concurrently.",
			"Give subagents concise instructions and ask follow-up questions when their reports are unclear.",
			"Subagent reports arrive as participant messages; they exclude child thinking and tool activity.",
		],
		description: "Manage up to ten persistent child agents by default. Start a new child or resume a saved one, queue follow-ups to active children, inspect status, wait for completion, or stop them. For resumption, supply id and put the new instruction in task; message does not resume sessions. Child agents cannot use this tool.",
		parameters: SubagentParams,
		renderCall(args, theme) { return renderSubagentCall(args, theme); },
		renderResult(result, options, theme) { return renderSubagentResult(result, options, theme); },
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			manager.setMainContext(ctx);
			if (ctx.mode === "print" || ctx.mode === "json") manager.enableOneShotMode();
			const input = params as SubagentInput;
			let text: string;
			let reportAgentIds: string[] = [];
			let started: Awaited<ReturnType<typeof manager.start>> | undefined;
			let shouldEndTurn = false;
			switch (input.action) {
				case "start":
					started = await manager.start(ctx, input);
					text = started.text;
					break;
				case "message":
					text = await manager.message(ctx, input.id, input.message);
					break;
				case "status":
					text = manager.status(ctx, input.id);
					break;
				case "stop":
					text = await manager.stop(ctx, input.id, signal);
					break;
				case "wait":
					const waitResult = await manager.wait(ctx, input.id, signal, true);
					text = waitResult.text;
					reportAgentIds = waitResult.reportAgentIds;
					break;
			}
			const shouldWaitForCompletion = started && Boolean(input.task?.trim()) && input.wait !== false;
			if (shouldWaitForCompletion) {
				const waitResult = await manager.wait(ctx, started.record.id, signal);
				text = `${text}\n${waitResult.text}`;
				shouldEndTurn = true;
			}
			const result = subagentToolResult(text, input.action, reportAgentIds);
			return shouldEndTurn ? { ...result, terminate: true } : result;
		},
	});
}
