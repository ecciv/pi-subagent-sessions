import assert from "node:assert/strict";
import test from "node:test";
import { ReportGate, waitForChildrenToSettle } from "../report-gate.ts";

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


test("wait continues to block while a child is stopping", async () => {
	const gate = new ReportGate();
	let status = "stopping";
	let completed = false;
	const waiting = waitForChildrenToSettle(gate, () => [status]).then(() => { completed = true; });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(completed, false);
	status = "stopped";
	gate.release();
	await waiting;
	assert.equal(completed, true);
});

test("a wait can be cancelled without stopping its child", async () => {
	const gate = new ReportGate();
	const controller = new AbortController();
	const child = { status: "running" };
	const waiting = waitForChildrenToSettle(gate, () => [child.status], controller.signal);
	controller.abort(new Error("Cancelled by user"));
	await assert.rejects(waiting, /Cancelled by user/);
	assert.equal(child.status, "running");
	gate.release(); // A cancelled waiter must not be called later.
});

test("wait for children ignores progress reports and completes only when all settle", async () => {
	const gate = new ReportGate();
	const children = [{ status: "running" }, { status: "running" }];
	let completed = false;
	const waiting = waitForChildrenToSettle(gate, () => children.map((child) => child.status))
		.then(() => { completed = true; });

	gate.release(); // A progress report must not end the wait.
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(completed, false);

	children[0]!.status = "done";
	gate.release();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(completed, false);

	children[1]!.status = "done";
	gate.release();
	await waiting;
	assert.equal(completed, true);
});
