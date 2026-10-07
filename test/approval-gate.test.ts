import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalGate } from "../approval-gate.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

test("concurrent requests for the same approval share one confirmation", async () => {
	const gate = new ApprovalGate();
	const decision = deferred<boolean>();
	let promptCount = 0;
	const confirm = () => {
		promptCount++;
		return decision.promise;
	};

	const requests = [1, 2, 3].map(() => gate.ensureApproved("model:high", confirm, "Declined"));
	await Promise.resolve();
	assert.equal(promptCount, 1);

	decision.resolve(true);
	await Promise.all(requests);
	await gate.ensureApproved("model:high", confirm, "Declined");
	assert.equal(promptCount, 1, "accepted approval should be cached for later requests");
});

test("a rejected shared confirmation fails all callers and can be retried", async () => {
	const gate = new ApprovalGate();
	const decision = deferred<boolean>();
	let promptCount = 0;
	const confirm = () => {
		promptCount++;
		return decision.promise;
	};

	const first = gate.ensureApproved("model:high", confirm, "Declined");
	const second = gate.ensureApproved("model:high", confirm, "Declined");
	await Promise.resolve();
	assert.equal(promptCount, 1);
	decision.resolve(false);
	await assert.rejects(first, /Declined/);
	await assert.rejects(second, /Declined/);

	await gate.ensureApproved("model:high", async () => {
		promptCount++;
		return true;
	}, "Declined");
	assert.equal(promptCount, 2, "a declined approval should not remain cached");
});

test("different approval keys are confirmed independently", async () => {
	const gate = new ApprovalGate();
	let promptCount = 0;
	const confirm = async () => {
		promptCount++;
		return true;
	};

	await Promise.all([
		gate.ensureApproved("model:high", confirm, "Declined"),
		gate.ensureApproved("model:max", confirm, "Declined"),
	]);
	assert.equal(promptCount, 2);
});
