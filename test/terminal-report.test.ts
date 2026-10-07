import assert from "node:assert/strict";
import test from "node:test";
import { terminalReport } from "../terminal-report.ts";

test("a provider error without assistant text is still reported", () => {
	assert.match(terminalReport({
		status: "error", lastError: "No API key", errorReported: false,
		instructionCount: 1, reportCount: 0, reportCountAtRunStart: 0,
	}) ?? "", /Subagent failed: No API key/);
});

test("a completed child with no assistant text reports that fact", () => {
	assert.match(terminalReport({
		status: "done", errorReported: false,
		instructionCount: 1, reportCount: 2, reportCountAtRunStart: 2,
	}) ?? "", /without an assistant report/);
	assert.equal(terminalReport({
		status: "done", errorReported: false,
		instructionCount: 1, reportCount: 3, reportCountAtRunStart: 2,
	}), undefined);
});
test("an intentionally stopped child does not generate a terminal failure report", () => {
	assert.equal(terminalReport({
		status: "stopped", errorReported: false, instructionCount: 1, reportCount: 0, reportCountAtRunStart: 0,
	}), undefined);
});

