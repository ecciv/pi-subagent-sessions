export class ReportGate {
	private readonly waiters = new Set<() => void>();

	wait(ready = false): Promise<void> {
		if (ready) return Promise.resolve();
		return new Promise((resolve) => this.waiters.add(resolve));
	}

	release(): void {
		const waiters = [...this.waiters];
		this.waiters.clear();
		for (const resolve of waiters) resolve();
	}
}
