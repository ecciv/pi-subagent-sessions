export class ReportGate {
	private readonly waiters = new Set<() => void>();

	wait(ready = false, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Subagent wait aborted"));
		if (ready) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const done = () => {
				this.waiters.delete(done);
				signal?.removeEventListener("abort", abort);
				resolve();
			};
			const abort = () => {
				this.waiters.delete(done);
				reject(signal?.reason ?? new Error("Subagent wait aborted"));
			};
			this.waiters.add(done);
			signal?.addEventListener("abort", abort, { once: true });
		});
	}

	release(): void {
		const waiters = [...this.waiters];
		this.waiters.clear();
		for (const resolve of waiters) resolve();
	}
}
export async function waitForChildrenToSettle(
	gate: ReportGate,
	statuses: () => string[],
	signal?: AbortSignal,
): Promise<void> {
	while (statuses().some((status) => status === "running" || status === "stopping")) {
		await gate.wait(false, signal);
	}
	if (signal?.aborted) throw signal.reason ?? new Error("Subagent wait aborted");
}
