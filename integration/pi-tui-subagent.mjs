#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const integrationDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(integrationDir, "..");
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
const artifactDir = process.env.PI_SUBAGENT_TEST_OUTPUT
	? path.resolve(process.env.PI_SUBAGENT_TEST_OUTPUT)
	: path.join(repoDir, "artifacts", "pi-subagent-integration", runId);
const mainSessionDir = path.join(artifactDir, "main-sessions");
const extensionPath = path.join(repoDir, "index.ts");
const piBin = process.env.PI_BIN || "pi";
const tmuxBin = process.env.TMUX_BIN || "tmux";
const socketName = `pi-subagent-it-${process.pid}`;
const tmuxSession = "subagent-integration";
const paneTarget = `${tmuxSession}:0.0`;
const expectedOutput = "PI_SUBAGENT_WORKER_OK_7f3c9a";
const finalMarker = "PI_SUBAGENT_TUI_RESULT:";
const timeoutMs = Number(process.env.PI_SUBAGENT_TEST_TIMEOUT_MS || 300_000);
const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || "", ".pi", "agent"));
const childSessionDir = path.join(agentDir, "subagents", Buffer.from(repoDir).toString("base64url"));

const prompt = [
	"Use the `subagent` tool exactly once to start a new child (do not pass an id) named `pi-integration-worker`.",
	`Give it this task: run exactly \`printf '${expectedOutput}\\n'\` with bash, then report the exact stdout. Do not modify files.`,
	"Wait for the child to finish and report (leave the wait option unset). After it completes, reply with exactly one line:",
	`${finalMarker} ${expectedOutput}`,
].join("\n");

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
		...options,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`);
	}
	return result.stdout;
}

function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function tmux(args, options = {}) {
	return run(tmuxBin, ["-L", socketName, ...args], options);
}

function hasTmuxSession() {
	const result = spawnSync(tmuxBin, ["-L", socketName, "has-session", "-t", tmuxSession], { encoding: "utf8" });
	return result.status === 0;
}

function capturePane(history = false) {
	const args = ["capture-pane", "-p"];
	if (history) args.push("-S", "-");
	args.push("-t", paneTarget);
	return tmux(args);
}

function stripAnsi(value) {
	return value
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function jsonlFiles(root) {
	try {
		return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
			const fullPath = path.join(root, entry.name);
			if (entry.isDirectory()) return jsonlFiles(fullPath);
			return entry.isFile() && entry.name.endsWith(".jsonl") ? [fullPath] : [];
		});
	} catch {
		return [];
	}
}

function readEntries(filePath) {
	try {
		return readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

function mainSessionInfo() {
	const files = jsonlFiles(mainSessionDir).sort((a, b) => readFileSync(b).length - readFileSync(a).length);
	for (const filePath of files) {
		const entries = readEntries(filePath);
		const session = entries.find((entry) => entry.type === "session");
		if (!session) continue;
		const assistantText = entries
			.filter((entry) => entry.type === "message" && entry.message?.role === "assistant")
			.flatMap((entry) => (entry.message.content ?? []).filter((part) => part.type === "text").map((part) => String(part.text ?? "")))
			.join("\n");
		return { filePath, id: session.id, assistantText, entries };
	}
	return undefined;
}

function findOwnedChild(parentSessionId) {
	const matches = [];
	for (const filePath of jsonlFiles(childSessionDir)) {
		const entries = readEntries(filePath);
		const owner = entries.find((entry) => entry.type === "custom" && entry.customType === "subagent-owner");
		if (owner?.data?.parentSessionId !== parentSessionId) continue;
		const session = entries.find((entry) => entry.type === "session");
		matches.push({ filePath, id: session?.id, entries });
	}
	return matches.sort((a, b) => readFileSync(b.filePath).length - readFileSync(a.filePath).length)[0];
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function savePaneCapture() {
	if (!hasTmuxSession()) return;
	const visible = capturePane();
	const history = capturePane(true);
	writeFileSync(path.join(artifactDir, "tui-visible.txt"), visible);
	writeFileSync(path.join(artifactDir, "tui-history.txt"), history);
	return { visible };
}

function writeManifest(data) {
	writeFileSync(path.join(artifactDir, "manifest.json"), `${JSON.stringify(data, null, 2)}\n`);
}

async function main() {
	mkdirSync(mainSessionDir, { recursive: true });
	const version = run(piBin, ["--version"]);
	const tmuxVersion = run(tmuxBin, ["-V"]);
	const provider = process.env.PI_SUBAGENT_TEST_PROVIDER || process.env.PI_PROVIDER;
	const model = process.env.PI_SUBAGENT_TEST_MODEL || process.env.PI_MODEL;
	const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", PI_OFFLINE: "1", PI_CODING_AGENT_SESSION_DIR: mainSessionDir };
	for (const key of ["PI_SESSION_FILE", "PI_SESSION_ID", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];

	const args = [
		"--no-extensions", "--extension", extensionPath,
		"--approve", "--no-context-files", "--tools", "subagent",
		"--thinking", "low", "--name", "pi-subagent-integration-main",
		"--session-dir", mainSessionDir,
	];
	if (provider) args.push("--provider", provider);
	if (model) args.push("--model", model);
	args.push(prompt);

	let finalAssistantText = "";
	let capture;
	let failure;
	try {
		spawnSync(tmuxBin, ["-L", socketName, "kill-server"], { encoding: "utf8" });
		const shellCommand = ["cd", shellQuote(repoDir), "&&", "exec", shellQuote(piBin), ...args.map(shellQuote)].join(" ");
		tmux(["new-session", "-d", "-s", tmuxSession, "-x", "120", "-y", "40", "-c", repoDir, "sleep 600"], { env });
		tmux(["set-option", "-g", "extended-keys", "on"]);
		tmux(["respawn-pane", "-k", "-t", paneTarget, shellCommand]);

		const deadline = Date.now() + timeoutMs;
		let lastScreen = "";
		let idleSamples = 0;
		let jobSettled = false;
		while (Date.now() < deadline) {
			if (!hasTmuxSession()) throw new Error(`Pi exited before the integration task completed. Last TUI output:\n${lastScreen}`);
			lastScreen = stripAnsi(capturePane());
			const session = mainSessionInfo();
			const finalResponsePresent = session?.assistantText.includes(finalMarker) && session.assistantText.includes(expectedOutput);
			if (finalResponsePresent) {
				finalAssistantText = session.assistantText;
				if (/\bWorking\b/.test(lastScreen)) idleSamples = 0;
				else idleSamples++;
				if (idleSamples >= 2) { jobSettled = true; break; }
			} else {
				idleSamples = 0;
			}
			if (/No API key found|Authentication failed|Potentially more expensive.*requires interactive approval/i.test(lastScreen)) {
				throw new Error(`Pi could not start the integration task:\n${lastScreen}`);
			}
			await delay(500);
		}
		if (!jobSettled) throw new Error(`Timed out after ${timeoutMs}ms waiting for Pi's final settled response. Last TUI output:\n${lastScreen}`);

		capture = savePaneCapture();
		const visibleText = stripAnsi(capture.visible);
		writeFileSync(path.join(artifactDir, "assistant-result.txt"), `${finalAssistantText.trim()}\n`);
		assert.match(finalAssistantText, new RegExp(`${finalMarker}\\s*${expectedOutput}`), "Pi's final answer should contain the exact worker output");
		assert.match(visibleText, new RegExp(`${finalMarker}\\s*${expectedOutput}`), "The finished result should be visible in the captured TUI pane");
		assert.doesNotMatch(visibleText, /\bWorking\b/, "the captured TUI should be idle after the final answer");
	} catch (error) {
		failure = error;
		try { capture ??= savePaneCapture(); } catch { /* Preserve the original failure. */ }
	} finally {
		if (hasTmuxSession()) {
			spawnSync(tmuxBin, ["-L", socketName, "send-keys", "-t", paneTarget, "C-c"], { encoding: "utf8" });
			await delay(500);
		}
		spawnSync(tmuxBin, ["-L", socketName, "kill-server"], { encoding: "utf8" });
	}

	const mainSession = mainSessionInfo();
	let childSession;
	if (mainSession) {
		copyFileSync(mainSession.filePath, path.join(artifactDir, "main-session.jsonl"));
		childSession = findOwnedChild(mainSession.id);
		if (childSession) copyFileSync(childSession.filePath, path.join(artifactDir, "child-session.jsonl"));
		else if (!failure) failure = new Error(`No saved child session was found for parent session ${mainSession.id}`);
	}
	if (!mainSession && !failure) failure = new Error(`No main Pi session file was saved under ${mainSessionDir}`);

	writeManifest({
		status: failure ? "failed" : "passed",
		startedWith: { pi: version.trim(), tmux: tmuxVersion.trim(), provider: provider || "settings default", model: model || "settings default" },
		cwd: repoDir,
		mainSessionId: mainSession?.id,
		mainSessionSource: mainSession?.filePath,
		childSessionId: childSession?.id,
		childSessionSource: childSession?.filePath,
		artifacts: ["main-session.jsonl", "child-session.jsonl", "assistant-result.txt", "tui-visible.txt", "tui-history.txt"],
		error: failure ? String(failure.stack || failure) : undefined,
	});

	if (failure) throw failure;
	assert.ok(mainSession, "main session should be saved");
	assert.ok(childSession, "child session should be saved");
	console.log(`Pi subagent TUI integration test passed.`);
	console.log(`Artifacts: ${artifactDir}`);
	console.log(`Main session: ${path.join(artifactDir, "main-session.jsonl")}`);
	console.log(`Child session: ${path.join(artifactDir, "child-session.jsonl")}`);
	console.log(`TUI text: ${path.join(artifactDir, "tui-visible.txt")}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exitCode = 1;
});
