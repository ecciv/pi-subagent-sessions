export type ModelReference = {
	provider: string;
	id: string;
};

/**
 * Resolve a model name from models that are already available to the runtime.
 * Unqualified names prefer the foreground provider when several providers share
 * the same model ID; provider-qualified names remain exact.
 */
export function resolveModelReference<T extends ModelReference>(
	models: readonly T[],
	specification: string,
	preferredProvider?: string,
): T | undefined {
	const clean = specification.trim();
	const slash = clean.indexOf("/");
	if (slash > 0) {
		const provider = clean.slice(0, slash);
		const modelId = clean.slice(slash + 1);
		return models.find((model) => model.provider === provider && model.id === modelId);
	}

	const candidates = models.filter((model) => model.id === clean);
	return candidates.find((model) => model.provider === preferredProvider) ?? candidates[0];
}
