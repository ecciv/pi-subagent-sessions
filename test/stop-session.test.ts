import assert from "node:assert/strict";
import test from "node:test";
import {
	awaitStopOrAbort,
	stopAgentSession,
	type StoppableAgentSession,
	waitForStopOrTimeout,
} from "../stop-session.ts";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

function emptyQueue() {
	return { steering: [] as unknown[], followUp: [] as unknown[] };
}

test("stop clears queued work and aborts Bash before waiting for the agent", async () => {
	const calls: string[] = [];
	let clears = 0;
	const session: StoppableAgentSession = {
		isStreaming: false,
		clearQueue: () => {
			calls.push("clear queue");
			return clears++ === 0 ? { steering: ["steer"], followUp: ["follow-up"] } : emptyQueue();
		},
		abortBash: () => calls.push("abort Bash"),
		abort: async () => { calls.push("abort agent"); },
	};

	const discarded = await stopAgentSession(session, () => undefined);
	assert.equal(discarded, 2);
	assert.deepEqual(calls, ["clear queue", "abort Bash", "abort agent", "clear queue"]);
});

test("stop waits for prompt preflight and aborts a run that starts during it", async () => {
	const calls: string[] = [];
	const prompt = deferred();
	let pendingPrompt: Promise<void> | undefined = prompt.promise;
	let streaming = false;
	const session: StoppableAgentSession = {
		get isStreaming() { return streaming; },
		clearQueue: () => { calls.push("clear queue"); return emptyQueue(); },
		abortBash: () => calls.push("abort Bash"),
		abort: async () => {
			calls.push("abort agent");
			streaming = false;
		},
	};

	const stopping = stopAgentSession(session, () => pendingPrompt);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(calls.slice(0, 3), ["clear queue", "abort Bash", "abort agent"]);

	// Simulate the manager's agent_start handler interrupting a prompt that
	// completed preflight after the first abort observed an idle session.
	streaming = true;
	await session.abort();
	pendingPrompt = undefined;
	prompt.resolve(undefined);
	await stopping;

	assert.equal(streaming, false);
	assert.equal(calls.filter((call) => call === "abort agent").length, 2);
	assert.equal(calls.at(-1), "clear queue");
});

test("stop clears queues even when the abort operation rejects", async () => {
	const calls: string[] = [];
	const session: StoppableAgentSession = {
		isStreaming: true,
		clearQueue: () => { calls.push("clear queue"); return emptyQueue(); },
		abortBash: () => calls.push("abort Bash"),
		abort: async () => { calls.push("abort agent"); throw new Error("abort failed"); },
	};

	await assert.rejects(stopAgentSession(session, () => undefined), /abort failed/);
	assert.deepEqual(calls, ["clear queue", "abort Bash", "abort agent", "clear queue"]);
});

test("caller abort cancels only its wait, not the shared stop operation", async () => {
	const operation = deferred<number>();
	const controller = new AbortController();
	const waiting = awaitStopOrAbort(operation.promise, controller.signal);
	controller.abort(new Error("Stop wait cancelled"));

	await assert.rejects(waiting, /Stop wait cancelled/);
	operation.resolve(0);
	assert.equal(await operation.promise, 0);
});

test("shutdown timeout is bounded while the underlying stop may continue", async () => {
	const operation = deferred<void>();
	assert.equal(await waitForStopOrTimeout(operation.promise, 1), false);
	operation.resolve(undefined);
	assert.equal(await waitForStopOrTimeout(operation.promise, 10), true);
});
