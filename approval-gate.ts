export class ApprovalGate {
	private readonly approved = new Set<string>();
	private readonly pending = new Map<string, Promise<void>>();

	async ensureApproved(
		key: string,
		confirm: () => Promise<boolean>,
		rejectionMessage: string,
	): Promise<void> {
		if (this.approved.has(key)) return;

		const existing = this.pending.get(key);
		if (existing) return existing;

		let approval: Promise<void>;
		approval = Promise.resolve()
			.then(confirm)
			.then((accepted) => {
				if (!accepted) throw new Error(rejectionMessage);
				this.approved.add(key);
			})
			.finally(() => {
				if (this.pending.get(key) === approval) this.pending.delete(key);
			});
		this.pending.set(key, approval);
		return approval;
	}
}
