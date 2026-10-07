import assert from "node:assert/strict";
import test from "node:test";
import { subagentToolResult } from "../tool-result.ts";

test("subagent tool results do not terminate the foreground turn", () => {
	const result = subagentToolResult("Started reviewer.", "start");

	assert.deepEqual(result, {
		content: [{ type: "text", text: "Started reviewer." }],
		details: { action: "start" },
	});
	assert.equal("terminate" in result, false);
});


test("subagent wait results record which saved reports were returned", () => {
	assert.deepEqual(subagentToolResult("Saved review", "wait", ["child-123"]), {
		content: [{ type: "text", text: "Saved review" }],
		details: { action: "wait", reportAgentIds: ["child-123"] },
	});
});
