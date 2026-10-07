import assert from "node:assert/strict";
import test from "node:test";
import { formatReportBatch, MAX_REPORT_BATCH_BYTES } from "../report-format.ts";

test("small batches preserve both participant reports", () => {
	const text = formatReportBatch([
		{ agent: { name: "one", shortId: "a1" }, text: "first" },
		{ agent: { name: "two", shortId: "b2" }, text: "second" },
	]);
	assert.match(text, /\[one a1\]\nfirst/);
	assert.match(text, /\[two b2\]\nsecond/);
});

test("parallel long reports cannot overflow a foreground message", () => {
	const reports = Array.from({ length: 10 }, (_, i) => ({
		agent: { name: `child-${i}`, shortId: String(i) },
		text: "x".repeat(12_000),
	}));
	const batch = formatReportBatch(reports);
	assert.ok(Buffer.byteLength(batch) <= MAX_REPORT_BATCH_BYTES);
	assert.match(batch, /\[child-9 9\]/);
	assert.match(batch, /full text is in the saved child transcript/);
});

test("UTF-8 reports stay under the byte cap without splitting characters", () => {
	const reports = Array.from({ length: 10 }, (_, i) => ({
		agent: { name: `child-${i}`, shortId: String(i) },
		text: "🦀".repeat(12_000),
	}));
	const batch = formatReportBatch(reports);
	assert.ok(Buffer.byteLength(batch) <= MAX_REPORT_BATCH_BYTES);
	assert.ok(!batch.includes("\uFFFD"));
});
