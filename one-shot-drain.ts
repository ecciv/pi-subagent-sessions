import { ReportGate } from "./report-gate.ts";

/** Hold the one-shot prompt open for children, then trigger exactly one report turn. */
export class OneShotDrain {
	private readonly childrenSettled = new ReportGate();
	private readonly reportTurnSettled = new ReportGate();
	private delivering = false;
	private closed = false;

	wake(): void {
		this.childrenSettled.release();
	}

	close(): void {
		this.closed = true;
		this.childrenSettled.release();
		this.reportTurnSettled.release();
	}

	async settle<T>(active: () => boolean, takeReports: () => T | undefined, deliver: (reports: T) => void): Promise<void> {
		if (this.closed) return;
		if (this.delivering) {
			this.delivering = false;
			try {
				// The report turn may have launched more children. Drain them before
				// allowing the original one-shot prompt to exit.
				await this.deliverPending(active, takeReports, deliver);
			} finally {
				this.reportTurnSettled.release();
			}
			return;
		}
		await this.deliverPending(active, takeReports, deliver);
	}

	private async deliverPending<T>(active: () => boolean, takeReports: () => T | undefined, deliver: (reports: T) => void): Promise<void> {
		while (!this.closed && active()) await this.childrenSettled.wait();
		if (this.closed) return;
		const reports = takeReports();
		if (reports === undefined) return;
		this.delivering = true;
		const reportTurn = this.reportTurnSettled.wait();
		try {
			deliver(reports);
			await reportTurn;
		} catch (error) {
			this.delivering = false;
			this.reportTurnSettled.release();
			throw error;
		}
	}
}
