import assert from "node:assert/strict";
import test from "node:test";
import { childSettings } from "../child-settings.ts";

test("new children inherit foreground model and thinking", () => {
	assert.deepEqual(childSettings(false, "parent-model", "medium"), { model: "parent-model", thinking: "medium" });
});

test("saved children restore their own model and thinking unless explicitly overridden", () => {
	assert.deepEqual(childSettings(true, "parent-model", "medium"), { model: undefined, thinking: undefined });
	assert.deepEqual(childSettings(true, "parent-model", "medium", undefined, "high"), { model: undefined, thinking: "high" });
	assert.deepEqual(childSettings(true, "parent-model", "medium", "other-model"), { model: "other-model", thinking: undefined });
});
