export type WaitReportRecord = {
	id: string;
	name: string;
	shortId: string;
	reportCount: number;
	waitedReportCount: number;
	lastQueuedReport?: string;
};

export type WaitReportSource = Pick<WaitReportRecord, "id" | "name" | "shortId">;
export type WaitReport<T extends WaitReportSource> = { agent: T; text: string };

export function collectWaitReports<
	TRecord extends WaitReportRecord,
	TPending extends WaitReport<WaitReportSource>,
>(
	records: readonly TRecord[],
	pendingReports: readonly TPending[],
): { reports: Array<TPending | WaitReport<TRecord>>; remainingReports: TPending[] } {
	const selectedIds = new Set(records.map((record) => record.id));
	const reports: Array<TPending | WaitReport<TRecord>> = pendingReports.filter((report) => selectedIds.has(report.agent.id));

	for (const record of records) {
		if (record.reportCount <= record.waitedReportCount || !record.lastQueuedReport) continue;
		if (reports.some((report) => report.agent.id === record.id && report.text === record.lastQueuedReport)) continue;
		reports.push({ agent: record, text: record.lastQueuedReport });
	}

	return {
		reports,
		remainingReports: pendingReports.filter((report) => !selectedIds.has(report.agent.id)),
	};
}
