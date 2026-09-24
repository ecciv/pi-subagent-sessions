import assert from "node:assert/strict";
import test from "node:test";
import { ReportGate } from "../report-gate.ts";

test("ReportGate waits until a report is released", async () => {
	const gate = new ReportGate();
	let released = false;
	const waiting = gate.wait().then(() => { released = true; });

	await Promise.resolve();
	assert.equal(released, false);
	gate.release();
	await waiting;
	assert.equal(released, true);
});

test("ReportGate releases all concurrent waiters and skips an already-ready wait", async () => {
	const gate = new ReportGate();
	let released = 0;
	const first = gate.wait().then(() => released++);
	const second = gate.wait().then(() => released++);
	gate.release();
	await Promise.all([first, second]);
	assert.equal(released, 2);
	await gate.wait(true);
});
