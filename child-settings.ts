/** Passing undefined lets createAgentSession restore a saved child's own model/thinking. */
export function childSettings<TModel, TThinking>(
	resuming: boolean,
	parentModel: TModel | undefined,
	parentThinking: TThinking,
	modelOverride?: TModel,
	thinkingOverride?: TThinking,
): { model: TModel | undefined; thinking: TThinking | undefined } {
	return {
		model: modelOverride ?? (resuming ? undefined : parentModel),
		thinking: thinkingOverride ?? (resuming ? undefined : parentThinking),
	};
}
