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
	type SelectItem,
} from "@earendil-works/pi-tui";

const EXTENSION_PATH = fileURLToPath(import.meta.url);
const EXTENSION_NAME = "subagent";
const MAX_REPORT_TEXT = 12_000;
const DEFAULT_CONFIG: SubagentConfig = {
	maxActive: 6,
	progressTimeoutMs: 60_000,
	progressTokenThreshold: 30_000,
	progressRequestCooldownMs: 300_000,
	reportBatchWindowMs: 2_000,
	maxReportCharacters: MAX_REPORT_TEXT,
	allowExpensiveModels: false,
	childTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
};

const CHILD_INSTRUCTIONS = `
You are a subagent managed by a foreground Pi agent.

Work only on the task assigned by the coordinator. Be concise. At the end of each meaningful turn, report useful findings, decisions, blockers, and the next step. Do not dump tool transcripts. Do not reveal hidden reasoning. Ask for clarification when the coordinator's instructions are unclear. You cannot spawn or manage other subagents.
`;

type AgentStatus = "running" | "done" | "stopped" | "error";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
};

type SubagentConfig = {
	maxActive: number;
	progressTimeoutMs: number;
	progressTokenThreshold: number;
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
	cwd: string;
	session: AgentSession;
	sessionFile: string;
	model?: Model<any>;
	thinkingLevel: ThinkingLevel;
	status: AgentStatus;
	createdAt: number;
	startedAt?: number;
	lastTurnStartedAt?: number;
	turnStartingTokens?: number;
	lastWatchdogAt?: number;
	lastReportAt?: number;
	watchdogTimer?: ReturnType<typeof setInterval>;
	lastError?: string;
	lastReport?: string;
	unsubscribe: () => void;
};

type StoredSession = {
	id: string;
	path: string;
	name?: string;
	cwd: string;
	modified: Date;
	messageCount: number;
};

type Report = {
	agent: SubagentRecord;
	text: string;
};

const ACTIONS = StringEnum(["start", "message", "status", "stop"] as const, {
	description: "start/resume, queue a message, inspect, or stop a subagent",
});
const THINKING_LEVELS = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, {
	description: "Thinking level override for a new or resumed subagent",
});

const SubagentParams = Type.Object({
	action: ACTIONS,
	id: Type.Optional(Type.String({ description: "Subagent ID; omit for start or status-all" })),
	task: Type.Optional(Type.String({ description: "Initial task, or queued instruction when starting/resuming" })),
	message: Type.Optional(Type.String({ description: "Concise queued instruction for the subagent" })),
	name: Type.Optional(Type.String({ description: "Short display name for a new subagent" })),
	model: Type.Optional(Type.String({ description: "Optional provider/model override" })),
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

function emptyUsage(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
}

function addUsage(target: UsageTotals, usage: any): void {
	if (!usage) return;
	target.input += Number(usage.input ?? 0);
	target.output += Number(usage.output ?? 0);
	target.cacheRead += Number(usage.cacheRead ?? 0);
	target.cacheWrite += Number(usage.cacheWrite ?? 0);
	target.total += Number(usage.totalTokens ?? usage.total ?? 0);
	target.cost += Number(usage.cost?.total ?? 0);
}

function usageFromEntries(entries: any[]): UsageTotals {
	const usage = emptyUsage();
	for (const entry of entries) {
		const message = entry?.type === "message" ? entry.message : entry;
		if (message?.role === "assistant" || message?.role === "toolResult") addUsage(usage, message.usage);
	}
	return usage;
}

function recordUsage(session: AgentSession): UsageTotals {
	return usageFromEntries(session.messages as any[]);
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
	const clean = specification.trim();
	const slash = clean.indexOf("/");
	if (slash > 0) return ctx.modelRegistry.find(clean.slice(0, slash), clean.slice(slash + 1));
	return ctx.modelRegistry.getAll().find((model) => model.id === clean);
}


function isActive(record: SubagentRecord): boolean {
	return record.status === "running";
}

function messageForEntry(entry: any): string[] {
	if (entry.type !== "message") return [];
	const message = entry.message;
	if (!message) return [];
	if (message.role === "user") return [`USER: ${textFromContent(message.content)}`];
	if (message.role === "assistant") {
		const lines: string[] = [];
		for (const part of message.content ?? []) {
			if (part.type === "text") lines.push(`ASSISTANT: ${part.text}`);
			else if (part.type === "thinking") lines.push(`THINKING: ${part.thinking}`);
			else if (part.type === "toolCall") lines.push(`TOOL CALL: ${part.name} ${JSON.stringify(part.arguments)}`);
		}
		return lines;
	}
	if (message.role === "toolResult") {
		return [`TOOL RESULT (${message.toolName}): ${textFromContent(message.content)}`];
	}
	if (message.role === "custom") return [`CUSTOM: ${textFromContent(message.content)}`];
	return [];
}

class SubagentManager {
	private readonly agents = new Map<string, SubagentRecord>();
	private readonly approvedExpensive = new Set<string>();
	private pendingReports: Report[] = [];
	private reportTimer?: ReturnType<typeof setTimeout>;
	private mainBusy = false;
	private shuttingDown = false;
	private ui?: ExtensionContext["ui"];
	private mainCwd?: string;
	private oneShotKeepAlive = false;
	private keepAliveQueued = false;
	private sendKeepAlive?: () => void;
	private mainContext?: ExtensionContext;
	private summaryPending = false;
	private summaryQueued = false;
	private sendSummary?: () => void;

	setMainContext(ctx: ExtensionContext): void {
		this.ui = ctx.ui;
		this.mainCwd = ctx.cwd;
		this.mainContext = ctx;
		this.refreshWidget();
	}

	setMainBusy(busy: boolean): void {
		this.mainBusy = busy;
		if (busy) this.keepAliveQueued = false;
		if (!busy) this.onMainSettled();
	}

	enableOneShotKeepAlive(): void {
		this.oneShotKeepAlive = true;
	}

	requestOneShotKeepAlive(): void {
		this.oneShotKeepAlive = true;
		this.queueKeepAliveIfNeeded();
	}

	setKeepAliveSender(sender: () => void): void {
		this.sendKeepAlive = sender;
	}

	setSummarySender(sender: () => void): void {
		this.sendSummary = sender;
	}

	private queueKeepAliveIfNeeded(): void {
		if (!this.oneShotKeepAlive || this.keepAliveQueued || this.shuttingDown) return;
		if (!this.mainCwd) return;
		if (this.listActive(this.mainCwd).length === 0 && this.pendingReports.length === 0) return;
		// A pending report also needs a live foreground turn in one-shot mode.
		if (this.pendingReports.length === 0 && this.reportTimer) return;
		this.keepAliveQueued = true;
		this.sendKeepAlive?.();
	}

	private markCompletionIfReady(): void {
		if (this.recordsForCwd(this.mainCwd ?? "").length === 0) return;
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
		this.queueKeepAliveIfNeeded();
	}

	private config(): SubagentConfig {
		return loadConfig();
	}

	private recordsForCwd(cwd: string): SubagentRecord[] {
		return [...this.agents.values()].filter((agent) => agent.cwd === cwd);
	}

	private activeCount(cwd: string): number {
		return this.recordsForCwd(cwd).filter(isActive).length;
	}

	private findActive(id: string | undefined, cwd: string): SubagentRecord | undefined {
		if (!id) return undefined;
		const candidates = this.recordsForCwd(cwd).filter((agent) => agent.id === id || agent.shortId === id || agent.id.startsWith(id) || agent.id.endsWith(id));
		return candidates.length === 1 ? candidates[0] : undefined;
	}

	private async resolveStoredSession(id: string, cwd: string): Promise<StoredSession | undefined> {
		const sessions = await SessionManager.list(cwd, sessionDirectory(cwd));
		const matching = sessions.filter((session) => session.id === id || session.id.startsWith(id));
		if (matching.length !== 1) return undefined;
		const session = matching[0];
		return {
			id: session.id,
			path: session.path,
			name: session.name,
			cwd: session.cwd || cwd,
			modified: session.modified,
			messageCount: session.messageCount,
		};
	}

	private async resolveModelAndThinking(
		ctx: ExtensionContext,
		requestedModel: string | undefined,
		requestedThinking: ThinkingLevel | undefined,
	): Promise<{ model: Model<any> | undefined; thinking: ThinkingLevel }> {
		const model = requestedModel ? getModelOverride(ctx, requestedModel) : ctx.model;
		if (requestedModel && !model) throw new Error(`Unknown model: ${requestedModel}`);
		const thinking = requestedThinking ?? (ctx.thinkingLevel as ThinkingLevel | undefined) ?? "medium";
		const currentThinking = (ctx.thinkingLevel as ThinkingLevel | undefined) ?? "medium";
		const changed = requestedModel !== undefined || requestedThinking !== undefined;
		if (changed && isMoreExpensive(ctx.model, model, currentThinking, thinking)) {
			const approvalKey = `${modelLabel(model, thinking)}`;
			const config = this.config();
			if (!config.allowExpensiveModels && !this.approvedExpensive.has(approvalKey)) {
				if (!ctx.hasUI) {
					throw new Error(`Potentially more expensive model configuration requires interactive approval: ${approvalKey}`);
				}
				const ok = await ctx.ui.confirm(
					"Use a more expensive subagent configuration?",
					`${approvalKey}\n\nThe foreground agent is currently using ${modelLabel(ctx.model, currentThinking)}.`,
				);
				if (!ok) throw new Error("Subagent model change was not approved.");
				this.approvedExpensive.add(approvalKey);
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
		const selected = await this.resolveModelAndThinking(ctx, params.model, params.thinking);
		const manager = stored
			? SessionManager.open(stored.path, sessionDirectory(ctx.cwd), ctx.cwd)
			: SessionManager.create(ctx.cwd, sessionDirectory(ctx.cwd));
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
		const { session } = await createAgentSession({
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			model: selected.model,
			thinkingLevel: selected.thinking,
			tools: config.childTools,
			resourceLoader,
			sessionManager: manager,
			settingsManager: SettingsManager.create(ctx.cwd, getAgentDir()),
			modelRuntime,
		});
		const fullId = session.sessionId;
		const name = params.name?.trim() || stored?.name || `agent-${fullId.slice(0, 6)}`;
		if (!stored && name) manager.appendSessionInfo(name);
		if (stored && params.name?.trim()) manager.appendSessionInfo(params.name.trim());
		const record: SubagentRecord = {
			id: fullId,
			shortId: fullId.slice(-8),
			name,
			task: params.task?.trim(),
			instructionCount: 0,
			cwd: ctx.cwd,
			session,
			sessionFile: session.sessionFile ?? manager.getSessionFile() ?? stored?.path ?? "",
			model: session.model ?? selected.model,
			thinkingLevel: session.thinkingLevel as ThinkingLevel,
			status: "done",
			createdAt: now(),
			unsubscribe: () => {},
		};
		record.unsubscribe = session.subscribe((event: any) => this.handleEvent(record, event));
		this.agents.set(record.id, record);
		this.refreshWidget();
		return record;
	}

	private handleEvent(record: SubagentRecord, event: any): void {
		if (this.shuttingDown) return;
		if (event.type === "agent_start") {
			record.status = "running";
			record.startedAt ??= now();
			this.refreshWatchdog(record);
			this.refreshWidget();
			return;
		}
		if (event.type === "turn_start") {
			record.status = "running";
			record.lastTurnStartedAt = now();
			record.turnStartingTokens = recordUsage(record.session).total;
			record.lastWatchdogAt = undefined;
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
				this.queueReport(record, text);
			}
			this.refreshWidget();
			return;
		}
		if (event.type === "agent_settled") {
			this.clearWatchdog(record);
			if (record.status !== "stopped" && record.status !== "error") record.status = "done";
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
			if (!timeoutReached && !tokenThresholdReached) return;
			if (record.lastWatchdogAt && now() - record.lastWatchdogAt < config.progressRequestCooldownMs) return;
			record.lastWatchdogAt = now();
			void record.session.steer(
				"Please briefly report your current progress, useful findings, blockers, and next step. Continue the task afterward.",
			).catch(() => {
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
		this.pendingReports.push({ agent: record, text: truncate(text.trim(), config.maxReportCharacters) });
		const reportAgentIds = new Set(this.pendingReports.map(({ agent }) => agent.id));
		for (const active of this.recordsForCwd(record.cwd).filter(isActive)) reportAgentIds.add(active.id);
		this.scheduleReportFlush(reportAgentIds.size > 1 ? config.reportBatchWindowMs : 0);
		if (this.oneShotKeepAlive) this.requestOneShotKeepAlive();
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
		const content = reports
			.map(({ agent, text }) => `[${agent.name} ${agent.shortId}]\n${text}`)
			.join("\n\n---\n\n");
		try {
			this.sendMainReport(content, reports);
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

	async start(ctx: ExtensionContext, params: SubagentInput): Promise<string> {
		const existing = params.id ? this.findActive(params.id, ctx.cwd) : undefined;
		let record = existing;
		if (!record && params.id) {
			const stored = await this.resolveStoredSession(params.id, ctx.cwd);
			if (!stored) throw new Error(`Unknown subagent session: ${params.id}`);
			record = await this.createSession(ctx, params, stored);
		}
		if (!record) record = await this.createSession(ctx, params);
		const instruction = params.task?.trim();
		if (instruction) await this.queueMessage(record, instruction);
		return `Started ${record.name} (${record.shortId})${instruction ? " and queued its task" : ""}.`;
	}

	async queueMessage(record: SubagentRecord, message: string): Promise<void> {
		const text = message.trim();
		if (!text) throw new Error("A non-empty message is required.");
		this.summaryPending = false;
		this.summaryQueued = false;
		record.instructionCount += 1;
		record.task ??= text;
		record.status = "running";
		record.startedAt ??= now();
		if (record.session.isStreaming) {
			await record.session.followUp(text);
		} else {
			void record.session.prompt(text, { source: "extension" }).catch((error: unknown) => {
				record.status = "error";
				record.lastError = error instanceof Error ? error.message : String(error);
				this.queueReport(record, `Subagent failed: ${record.lastError}`);
				this.refreshWidget();
			});
		}
		this.refreshWidget();
	}

	async message(ctx: ExtensionContext, id: string | undefined, message: string | undefined): Promise<string> {
		const record = this.findActive(id, ctx.cwd);
		if (!record) throw new Error(`Unknown active subagent: ${id ?? "(missing id)"}`);
		await this.queueMessage(record, message ?? "");
		return `Queued a message for ${record.name} (${record.shortId}).`;
	}

	async stop(ctx: ExtensionContext, id: string | undefined): Promise<string> {
		const record = this.findActive(id, ctx.cwd);
		if (!record) throw new Error(`Unknown active subagent: ${id ?? "(missing id)"}`);
		await record.session.abort();
		this.clearWatchdog(record);
		record.status = "stopped";
		this.markCompletionIfReady();
		this.refreshWidget();
		return `Stopped ${record.name} (${record.shortId}).`;
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
		return `${record.shortId} ${record.name} ${record.status} child-turns=${stats.turns} main-messages=${record.instructionCount} ${modelLabel(record.model, record.thinkingLevel)} ${formatDuration(stats.elapsedMs)} ↑${formatTokens(stats.usage.input)} ↓${formatTokens(stats.usage.output)} $${stats.usage.cost.toFixed(4)}${task}${error}`;
	}

	listActive(cwd: string): SubagentRecord[] {
		return this.recordsForCwd(cwd).filter(isActive);
	}

	async listStored(cwd: string): Promise<StoredSession[]> {
		const sessions = await SessionManager.list(cwd, sessionDirectory(cwd));
		return sessions.map((session) => ({
			id: session.id,
			path: session.path,
			name: session.name,
			cwd: session.cwd || cwd,
			modified: session.modified,
			messageCount: session.messageCount,
		}));
	}

	getRecord(id: string, cwd: string): SubagentRecord | undefined {
		return this.findActive(id, cwd);
	}

	async resume(ctx: ExtensionContext, stored: StoredSession, message?: string): Promise<SubagentRecord> {
		const record = await this.createSession(ctx, { action: "start", id: stored.id, task: message }, stored);
		if (message) await this.queueMessage(record, message);
		return record;
	}

	refreshWidget(): void {
		if (!this.ui || !this.mainCwd) return;
		const all = this.recordsForCwd(this.mainCwd);
		const childUsage = emptyUsage();
		for (const record of all) addUsage(childUsage, recordUsage(record));
		const mainUsage = this.mainContext ? usageFromEntries(this.mainContext.sessionManager.getEntries() as any[]) : emptyUsage();
		const combinedCost = mainUsage.cost + childUsage.cost;
		this.ui.setStatus(
			"subagents-cost",
			all.length > 0 ? `children $${childUsage.cost.toFixed(4)} · combined $${combinedCost.toFixed(4)}` : undefined,
		);
		const active = all.filter(isActive);
		if (active.length === 0) {
			this.ui.setWidget("subagents", undefined);
			return;
		}
		this.ui.setWidget(
			"subagents",
			active.map((record) => {
				const stats = recordStats(record);
				return `${record.status === "running" ? "●" : "○"} ${record.name} child-turns:${stats.turns} ${modelLabel(record.model, record.thinkingLevel)}  ${formatDuration(stats.elapsedMs)}  $${stats.usage.cost.toFixed(4)} task=${JSON.stringify(preview(record.task, 60))}`;
			}),
		);
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		if (this.reportTimer) clearTimeout(this.reportTimer);
		for (const record of this.agents.values()) {
			this.clearWatchdog(record);
			record.unsubscribe();
			if (record.session.isStreaming) {
				try {
					await record.session.abort();
				} catch {
					// Pi is already shutting down.
				}
			}
			record.session.dispose();
		}
		this.agents.clear();
		this.ui?.setWidget("subagents", undefined);
		this.ui?.setStatus("subagents-cost", undefined);
	}
}

function recordStats(record: SubagentRecord): { usage: UsageTotals; turns: number; elapsedMs: number } {
	const usage = recordUsage(record.session);
	const turns = (record.session.messages as any[]).filter((message) => message.role === "assistant").length;
	const lastTimestamp = [...(record.session.messages as any[])]
		.reverse()
		.find((message) => typeof message.timestamp === "number")?.timestamp;
	const end = record.status === "running" ? now() : Number(lastTimestamp ?? now());
	return { usage, turns, elapsedMs: Math.max(0, end - record.createdAt) };
}

function recordTranscript(record: SubagentRecord): string[] {
	const entries = record.session.sessionManager.getEntries() as any[];
	return entries.flatMap((entry) => messageForEntry(entry));
}

function storedTranscript(stored: StoredSession): string[] {
	try {
		const manager = SessionManager.open(stored.path);
		return manager.getEntries().flatMap((entry: any) => messageForEntry(entry));
	} catch (error) {
		return [`Unable to open session: ${error instanceof Error ? error.message : String(error)}`];
	}
}

async function showTranscript(ctx: ExtensionContext, title: string, linesSource: () => string[]): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Transcript viewing requires interactive TUI mode.", "warning");
		return;
	}
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		let offset = Math.max(0, linesSource().length - 32);
		const render = (width: number): string[] => {
			const lines = linesSource();
			const maxOffset = Math.max(0, lines.length - 32);
			offset = Math.max(0, Math.min(offset, maxOffset));
			const visible = lines.slice(offset, offset + 32).map((line) => truncateToWidth(line, Math.max(1, width - 4)));
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
			container.addChild(new Text(visible.length > 0 ? visible.join("\n") : theme.fg("dim", "No messages yet."), 1, 0));
			container.addChild(new Text(theme.fg("dim", `${offset + 1}-${Math.min(offset + visible.length, lines.length)} of ${lines.length}  ↑↓ scroll  home/end  esc close`), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			return container.render(width);
		};
		const timer = setInterval(() => tui.requestRender(), 500);
		return {
			render,
			handleInput(data: string) {
				const maxOffset = Math.max(0, linesSource().length - 32);
				if (matchesKey(data, Key.escape)) done();
				else if (matchesKey(data, Key.up)) { offset = Math.max(0, offset - 1); tui.requestRender(); }
				else if (matchesKey(data, Key.down)) { offset = Math.min(maxOffset, offset + 1); tui.requestRender(); }
				else if (matchesKey(data, Key.pageUp)) { offset = Math.max(0, offset - 16); tui.requestRender(); }
				else if (matchesKey(data, Key.pageDown)) { offset = Math.min(maxOffset, offset + 16); tui.requestRender(); }
				else if (matchesKey(data, Key.home)) { offset = 0; tui.requestRender(); }
				else if (matchesKey(data, Key.end)) { offset = maxOffset; tui.requestRender(); }
			},
			invalidate() {},
			dispose() { clearInterval(timer); },
		};
	}, { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%" } });
}

function renderSubagentCall(args: any, theme: any): Text {
	const action = String(args?.action ?? "?");
	const target = args?.id ? ` ${String(args.id).slice(-8)}` : "";
	let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `${action}${target}`);
	if (action === "start" && args?.name) text += ` ${theme.fg("muted", String(args.name))}`;
	const instruction = args?.task ?? args?.message;
	if (instruction) text += `\n  ${theme.fg("dim", preview(String(instruction), 180))}`;
	if (args?.model) text += `\n  ${theme.fg("muted", `model: ${args.model}`)}`;
	if (args?.thinking) text += ` ${theme.fg("muted", `thinking: ${args.thinking}`)}`;
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
	while (true) {
		const stored = await manager.listStored(ctx.cwd);
		const active = manager.listActive(ctx.cwd);
		const activeIds = new Set(active.map((record) => record.id));
		const items: SelectItem[] = [];
		for (const record of active) {
			const stats = recordStats(record);
			items.push({
				value: record.id,
				label: `● ${record.name} (${record.shortId})`,
				description: `${record.status} ${modelLabel(record.model, record.thinkingLevel)} · ${stats.turns} turns · ${formatDuration(stats.elapsedMs)} · $${stats.usage.cost.toFixed(4)}`,
			});
		}
		for (const session of stored) {
			if (activeIds.has(session.id)) continue;
			items.push({
				value: `stored:${session.id}`,
				label: `○ ${session.name || `agent-${session.id.slice(0, 6)}`} (${session.id.slice(0, 8)})`,
				description: `saved ${session.modified.toLocaleString()} · ${session.messageCount} messages`,
			});
		}
		if (items.length === 0) {
			ctx.ui.notify("No subagent sessions for this project.", "info");
			return;
		}
		const selected = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
			const list = new SelectList(items, Math.min(12, items.length), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Subagents")), 1, 0));
			container.addChild(new Text(theme.fg("dim", "Select a session to view its transcript, queue a message, stop it, or resume it."), 1, 0));
			container.addChild(list);
			container.addChild(new Text(theme.fg("dim", "enter select  esc close"), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			return {
				render: (width: number) => container.render(width),
				handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); },
				invalidate: () => container.invalidate(),
			};
		}, { overlay: true, overlayOptions: { width: "90%", maxHeight: "80%" } });
		if (!selected) return;
		const storedSelection = selected.startsWith("stored:");
		const id = storedSelection ? selected.slice("stored:".length) : selected;
		const record = manager.getRecord(id, ctx.cwd);
		const old = stored.find((session) => session.id === id);
		const action = await ctx.ui.select(
			`${record?.name || old?.name || id.slice(0, 8)} actions`,
			["View transcript", "Send queued message", "Stop agent", "Resume session", "Back"],
		);
		if (!action || action === "Back") continue;
		if (action === "View transcript") {
			if (record) await showTranscript(ctx, `${record.name} (${record.shortId})`, () => recordTranscript(record));
			else if (old) await showTranscript(ctx, `${old.name || old.id.slice(0, 8)} (${old.id.slice(0, 8)})`, () => storedTranscript(old));
			continue;
		}
		if (action === "Send queued message") {
			if (!record) {
				ctx.ui.notify("Resume the session before sending a message.", "warning");
				continue;
			}
			const message = await ctx.ui.editor("Queue a message for the subagent");
			if (message?.trim()) {
				try { await manager.message(ctx, record.id, message); ctx.ui.notify("Message queued.", "info"); }
				catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
			}
			continue;
		}
		if (action === "Stop agent") {
			if (!record) { ctx.ui.notify("That session is not currently active.", "info"); continue; }
			if (await ctx.ui.confirm("Stop subagent?", `${record.name} (${record.shortId})`)) {
				try { await manager.stop(ctx, record.id); ctx.ui.notify("Subagent stopped.", "info"); }
				catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
			}
			continue;
		}
		if (action === "Resume session") {
			if (!old && !record) { ctx.ui.notify("Session not found.", "error"); continue; }
			const message = await ctx.ui.editor("Optional instruction for the resumed subagent");
			try {
				if (record) await manager.queueMessage(record, message?.trim() || "Please continue from the current session.");
				else await manager.resume(ctx, old!, message?.trim() || undefined);
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
	pi.on("agent_settled", () => manager.setMainBusy(false));
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
	manager.setKeepAliveSender(() => {
		pi.sendMessage(
			{
				customType: "subagent-wait",
				content: "Subagents are still active. Wait for their next participant report, manage them with the subagent tool, and do not finish or do unrelated work.",
				display: false,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});
	manager.setSummarySender(() => {
		pi.sendMessage(
			{
				customType: "subagent-summary-request",
				content: "All subagent work is complete. Review the participant reports above and provide a concise user-facing summary of the work, decisions, commits, validation, and any limitations. Do not call subagent tools unless a genuine follow-up is needed.",
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
		promptSnippet: "Start, message, inspect, or stop persistent subagents",
		promptGuidelines: [
			"Use subagent only when the user explicitly asks for subagents or delegation.",
			"When subagents are active, use subagent to manage them rather than doing unrelated project work.",
			"Give subagents concise instructions and ask follow-up questions when their reports are unclear.",
			"Subagent reports arrive as participant messages; they exclude child thinking and tool activity.",
		],
		description: "Manage up to six persistent child agents. Start/resume them, queue instructions, inspect status, or stop them. Child agents cannot use this tool.",
		parameters: SubagentParams,
		renderCall(args, theme) { return renderSubagentCall(args, theme); },
		renderResult(result, options, theme) { return renderSubagentResult(result, options, theme); },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			manager.setMainContext(ctx);
			if (ctx.mode === "print" || ctx.mode === "json") manager.enableOneShotKeepAlive();
			const input = params as SubagentInput;
			let text: string;
			switch (input.action) {
				case "start":
					text = await manager.start(ctx, input);
					break;
				case "message":
					text = await manager.message(ctx, input.id, input.message);
					break;
				case "status":
					text = manager.status(ctx, input.id);
					break;
				case "stop":
					text = await manager.stop(ctx, input.id);
					break;
			}
			if (ctx.mode === "print" || ctx.mode === "json") manager.requestOneShotKeepAlive();
			return {
				content: [{ type: "text", text }],
				details: { action: input.action },
				terminate: true,
			};
		},
	});
}
