import assert from "node:assert/strict";
import test from "node:test";
import { resolveModelReference } from "../model-resolution.ts";

const models = [
	{ provider: "azure-openai-responses", id: "gpt-5.6-luna" },
	{ provider: "github-copilot", id: "gpt-5.6-luna" },
	{ provider: "github-copilot", id: "gpt-5.5" },
] as const;

test("unqualified names prefer the foreground provider", () => {
	assert.equal(resolveModelReference(models, "gpt-5.6-luna", "github-copilot")?.provider, "github-copilot");
});

test("provider-qualified names resolve exactly", () => {
	assert.equal(resolveModelReference(models, "azure-openai-responses/gpt-5.6-luna")?.provider, "azure-openai-responses");
});

test("resolution only considers models supplied as available", () => {
	const authenticatedModels = models.filter((model) => model.provider === "github-copilot");
	assert.equal(resolveModelReference(authenticatedModels, "gpt-5.6-luna")?.provider, "github-copilot");
	assert.equal(resolveModelReference(authenticatedModels, "unknown-model"), undefined);
});
