export interface StoppableAgentSession {
	readonly isStreaming: boolean;
	clearQueue(): { steering: readonly unknown[]; followUp: readonly unknown[] };
	abortBash(): void;
	abort(): Promise<void>;
}

/** Abort active tools and agent work, including prompts that were still in preflight. */
export async function stopAgentSession(
	session: StoppableAgentSession,
	pendingPrompt: () => Promise<void> | undefined,
): Promise<number> {
	let discardedMessages = 0;
	const clearQueue = () => {
		const queued = session.clearQueue();
		discardedMessages += queued.steering.length + queued.followUp.length;
	};

	try {
		while (true) {
			clearQueue();
			session.abortBash();
			await session.abort();

			const prompt = pendingPrompt();
			if (prompt) await prompt;
			if (!session.isStreaming && !pendingPrompt()) break;
		}
	} finally {
		// A follow-up may have been queued while a prompt was still in preflight.
		clearQueue();
	}
	return discardedMessages;
}

/** Let an abort signal stop a caller's wait without cancelling the shared stop. */
export function awaitStopOrAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Subagent stop wait aborted"));

	return new Promise<T>((resolve, reject) => {
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			cleanup();
			reject(signal.reason ?? new Error("Subagent stop wait aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => { cleanup(); resolve(value); },
			(error: unknown) => { cleanup(); reject(error); },
		);
	});
}

/** Resolve false on timeout; rejection from the stop operation still counts as settled. */
export async function waitForStopOrTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
	if (timeoutMs <= 0) {
		await promise.catch(() => {});
		return true;
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	const stopped = promise.then(() => true, () => true);
	const timeout = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(false), timeoutMs);
	});
	try {
		return await Promise.race([stopped, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
