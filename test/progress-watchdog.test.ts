import assert from "node:assert/strict";
import test from "node:test";
import { shouldRequestProgress } from "../progress-watchdog.ts";

const base = {
	triggerReached: true,
	lastReportTurn: 0,
	lastWatchdogTurn: 0,
	minTurns: 5,
	now: 10_000,
	cooldownMs: 3_000,
};

test("progress trigger waits for the minimum number of turns", () => {
	assert.equal(shouldRequestProgress({ ...base, turnCount: 4 }), false);
	assert.equal(shouldRequestProgress({ ...base, turnCount: 5 }), true);
});

test("a child report restarts the minimum-turn interval", () => {
	assert.equal(shouldRequestProgress({ ...base, turnCount: 10, lastReportTurn: 6 }), false);
	assert.equal(shouldRequestProgress({ ...base, turnCount: 11, lastReportTurn: 6 }), true);
});

test("a previous watchdog request also starts a minimum-turn interval", () => {
	assert.equal(shouldRequestProgress({ ...base, turnCount: 9, lastWatchdogTurn: 5 }), false);
	assert.equal(shouldRequestProgress({ ...base, turnCount: 10, lastWatchdogTurn: 5 }), true);
});

test("the time cooldown remains in force across turns", () => {
	assert.equal(shouldRequestProgress({ ...base, turnCount: 5, lastWatchdogAt: 8_000, now: 10_000 }), false);
	assert.equal(shouldRequestProgress({ ...base, turnCount: 5, lastWatchdogAt: 6_000, now: 10_000 }), true);
});

test("no progress nudge is sent before a timeout or token trigger", () => {
	assert.equal(shouldRequestProgress({ ...base, triggerReached: false, turnCount: 20 }), false);
});
