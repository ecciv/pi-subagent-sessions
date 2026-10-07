import assert from "node:assert/strict";
import test from "node:test";
import { displaySessionId, shortSessionId, uniqueShortSessionId } from "../session-id.ts";

test("compact session ids use the random UUID tail", () => {
	const first = "019abcde-0000-7000-8000-111111111111";
	const second = "019abcde-0000-7000-8000-222222222222";

	assert.equal(shortSessionId(first), "11111111");
	assert.notEqual(shortSessionId(first), shortSessionId(second));
	assert.equal(shortSessionId("11111111-2"), "11111111-2");
});

test("compact session ids are disambiguated on collision", () => {
	const id = "019abcde-0000-7000-8000-111111111111";
	const compact = shortSessionId(id);

	assert.equal(uniqueShortSessionId(id, []), compact);
	assert.equal(uniqueShortSessionId(id, [compact]), id);
	const other = "019abcde-0000-7000-8001-111111111111";
	assert.equal(displaySessionId(id, [id, other]), id);
	assert.equal(displaySessionId(id, [id]), compact);
});
