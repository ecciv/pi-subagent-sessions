import assert from "node:assert/strict";
import test from "node:test";
import { collectWaitReports, type WaitReportRecord } from "../wait-result.ts";

type Record = WaitReportRecord & { marker?: string };

function record(id: string, reportCount: number, waitedReportCount: number, lastQueuedReport?: string): Record {
	return {
		id,
		name: id,
		shortId: id,
		reportCount,
		waitedReportCount,
		lastQueuedReport,
		marker: "preserved",
	};
}

test("wait can return the latest report from an already-completed child", () => {
	const completed = record("child-1", 1, 0, "Task finished");
	const result = collectWaitReports([completed], []);

	assert.deepEqual(result.reports, [{ agent: completed, text: "Task finished" }]);
	assert.deepEqual(result.remainingReports, []);
});
test("a report discarded by stop is not recovered by a later wait", () => {
	const stopped = record("child-1", 1, 1, "Discarded on stop");
	const result = collectWaitReports([stopped], []);
	assert.deepEqual(result.reports, []);
	assert.deepEqual(result.remainingReports, []);
});


test("wait drains selected queued reports without duplicating the latest report", () => {
	const selected = record("child-1", 2, 0, "Final report");
	const unrelated = record("child-2", 1, 0, "Other report");
	const pending = [
		{ agent: selected, text: "Progress report" },
		{ agent: selected, text: "Final report" },
		{ agent: unrelated, text: "Other report" },
	];
	const result = collectWaitReports([selected], pending);

	assert.deepEqual(result.reports, pending.slice(0, 2));
	assert.deepEqual(result.remainingReports, [pending[2]]);
});

test("wait does not repeat reports already returned to the foreground", () => {
	const completed = record("child-1", 1, 1, "Already returned");
	const result = collectWaitReports([completed], []);

	assert.deepEqual(result.reports, []);
	assert.deepEqual(result.remainingReports, []);
});
