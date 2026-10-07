import assert from "node:assert/strict";
import test from "node:test";
import { OneShotDrain } from "../one-shot-drain.ts";

test("one-shot drain waits for child events, then sends one report turn", async () => {
	const drain = new OneShotDrain();
	let active = true;
	let reports: string[] = [];
	const sent: string[][] = [];
	let finished = false;
	const foreground = drain.settle(
		() => active,
		() => reports.length ? reports.splice(0) : undefined,
		(batch) => sent.push(batch),
	).then(() => { finished = true; });
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(sent.length, 0); // No LLM polling turns while the child is active.
	active = false;
	reports = ["final child report"];
	drain.wake();
	await Promise.resolve();
	assert.deepEqual(sent, [["final child report"]]);
	assert.equal(finished, false);
	await drain.settle(() => active, () => undefined, () => { throw new Error("duplicate turn"); });
	await foreground;
	assert.equal(finished, true);
	assert.equal(sent.length, 1);
});

test("one-shot drain closes without delivering an unfinished report", async () => {
	const drain = new OneShotDrain();
	let sent = false;
	const foreground = drain.settle(() => true, () => "report", () => { sent = true; });
	drain.close();
	await foreground;
	assert.equal(sent, false);
});

test("one-shot drain handles an immediately settled report turn", async () => {
	const drain = new OneShotDrain();
	let sends = 0;
	await drain.settle(
		() => false,
		() => "report",
		() => { sends++; void drain.settle(() => false, () => undefined, () => {}); },
	);
	assert.equal(sends, 1);
});

test("new children started in the report turn are drained before exit", async () => {
	const drain = new OneShotDrain();
	let active = false;
	const queued = ["first"];
	const delivered: string[] = [];
	const send = (report: string) => { delivered.push(report); };
	const take = () => queued.shift();
	let finished = false;
	const initial = drain.settle(() => active, take, send).then(() => { finished = true; });
	assert.deepEqual(delivered, ["first"]);
	active = true; // The model started another child while processing "first".
	const reportTurn = drain.settle(() => active, take, send);
	await Promise.resolve();
	assert.equal(finished, false);
	active = false;
	queued.push("second");
	drain.wake();
	await Promise.resolve();
	assert.deepEqual(delivered, ["first", "second"]);
	await drain.settle(() => active, take, send);
	await Promise.all([initial, reportTurn]);
	assert.equal(finished, true);
});
