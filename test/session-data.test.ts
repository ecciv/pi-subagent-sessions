import assert from "node:assert/strict";
import test from "node:test";
import { entryArray, parentSessionIdFromEntries, sessionEntries, subagentReportIdsFromEntries, usageFromEntries, usageFromSession } from "../session-data.ts";

test("entryArray accepts the normal session-entry array", () => {
	const entries = [{ id: "one" }, { id: "two" }];
	assert.deepEqual(entryArray(entries), entries);
});

test("entryArray unwraps adapters exposing an entries collection", () => {
	const entries = [{ id: "one" }, { id: "two" }];
	assert.deepEqual(entryArray({ entries }), entries);
	assert.deepEqual(entryArray({ entries: new Set(entries) }), entries);
});

test("entryArray accepts other iterables and rejects non-collections", () => {
	assert.deepEqual(entryArray(new Set(["one", "two"])), ["one", "two"]);
	assert.deepEqual(entryArray((function* () { yield "one"; yield "two"; })()), ["one", "two"]);
	assert.deepEqual(entryArray(undefined), []);
	assert.deepEqual(entryArray(null), []);
	assert.deepEqual(entryArray({ entries: 42 }), []);
});

test("sessionEntries falls back when an agent session lacks a session manager", () => {
	const messages = [{ role: "assistant", usage: { cost: { total: 0.1 } } }];
	assert.deepEqual(sessionEntries({ messages }), messages);
	assert.deepEqual(sessionEntries({ sessionManager: { getEntries: () => ({ entries: messages }) } }), messages);
});


test("usageFromEntries accepts numeric costs", () => {
    assert.equal(
        usageFromEntries([{ role: "assistant", usage: { totalTokens: 5, cost: 0.125 } }]).cost,
        0.125,
    );
});

test("usageFromSession falls back when session entries have no usage", () => {
    const usage = usageFromSession({
        sessionManager: { getEntries: () => [{ type: "custom", customType: "subagent-owner" }] },
        messages: [{ role: "assistant", usage: { totalTokens: 7, cost: { total: 0.25 } } }],
    });
    assert.equal(usage.total, 7);
    assert.equal(usage.cost, 0.25);
});

test("usageFromSession uses the agent session's aggregate cost totals", () => {
    const usage = usageFromSession({
        getSessionStats: () => ({
            tokens: { input: 10, output: 5, cacheRead: 8, cacheWrite: 2, total: 25 },
            cost: 0.125,
        }),
        sessionManager: { getEntries: () => [] },
    });
    assert.deepEqual(usage, { input: 10, output: 5, cacheRead: 8, cacheWrite: 2, total: 25, cost: 0.125 });
});
test("parentSessionIdFromEntries reads the latest owner marker", () => {
    assert.equal(
        parentSessionIdFromEntries([
            { type: "custom", customType: "subagent-owner", data: { parentSessionId: "main-one" } },
            { type: "custom", customType: "subagent-owner", data: { parentSessionId: "main-two" } },
        ]),
        "main-two",
    );
    assert.equal(parentSessionIdFromEntries([{ type: "message", message: { role: "user" } }]), undefined);
});


test("subagent report tracking recognizes delivered reports and wait results", () => {
	const ids = subagentReportIdsFromEntries([
		{ type: "custom_message", customType: "subagent-report", details: { agents: ["child-a"] } },
		{ type: "message", message: { role: "toolResult", toolName: "subagent", details: { action: "wait", reportAgentIds: ["child-b"] } } },
		{ type: "message", message: { role: "toolResult", toolName: "subagent", details: { action: "status", reportAgentIds: ["ignored"] } } },
	]);

	assert.deepEqual(ids, new Set(["child-a", "child-b"]));
});


test("usageFromEntries handles session entries and direct messages", () => {
	const usage = usageFromEntries({
		entries: [
			{
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 16, cost: { total: 0.25 } },
				},
			},
			{ role: "toolResult", usage: { input: 3, output: 1, totalTokens: 4, cost: { total: 0.05 } } },
			{ role: "user", usage: { input: 999, totalTokens: 999 } },
			{ type: "compaction", usage: { input: 5, output: 2, totalTokens: 7, cost: { total: 0.07 } } },
			{ type: "branch_summary", usage: { input: 1, output: 0, totalTokens: 1, cost: { total: 0.01 } } },
		],
	});

	assert.deepEqual(usage, {
		input: 19,
		output: 7,
		cacheRead: 2,
		cacheWrite: 1,
		total: 28,
		cost: 0.38,
	});
});

test("usageFromEntries is safe for a missing or malformed collection", () => {
	assert.deepEqual(usageFromEntries(undefined), {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		cost: 0,
	});
	assert.deepEqual(usageFromEntries({ entries: "not-an-array" }), {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		cost: 0,
	});
});
