import assert from "node:assert/strict";
import test from "node:test";
import { selectOwnedSession } from "../session-selection.ts";

const sessions = [
	{ id: "019abcde-0000-7000-8000-111111111111", parentSessionId: "foreground-a" },
	{ id: "019abcde-0000-7000-8000-222222222222", parentSessionId: "foreground-b" },
];

test("saved sessions accept their displayed UUID suffix", () => {
	assert.equal(selectOwnedSession(sessions, "11111111", "foreground-a"), sessions[0]);
	assert.equal(selectOwnedSession(sessions, sessions[0].id, "foreground-a"), sessions[0]);
	assert.equal(selectOwnedSession(sessions, "019abcde-0000-7000-8000-1111", "foreground-a"), sessions[0]);
});

test("another foreground session's child cannot be resumed by any identifier", () => {
	assert.equal(selectOwnedSession(sessions, sessions[1].id, "foreground-a"), undefined);
	assert.equal(selectOwnedSession(sessions, "22222222", "foreground-a"), undefined);
	assert.equal(selectOwnedSession([{ id: "legacy" }], "legacy", "foreground-a"), undefined);
});

test("ambiguous saved identifiers never select an arbitrary child", () => {
	const collisions = [
		{ id: "019abcde-0000-7000-8000-111111111111", parentSessionId: "foreground-a" },
		{ id: "019abcde-0000-7000-8001-111111111111", parentSessionId: "foreground-a" },
	];
	assert.equal(selectOwnedSession(collisions, "11111111", "foreground-a"), undefined);
	assert.equal(selectOwnedSession(collisions, collisions[0].id, "foreground-a"), collisions[0]);
});
