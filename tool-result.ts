export function subagentToolResult(text: string, action: string, reportAgentIds: string[] = []): {
	content: [{ type: "text"; text: string }];
	details: { action: string; reportAgentIds?: string[] };
} {
	return {
		content: [{ type: "text", text }],
		details: reportAgentIds.length > 0 ? { action, reportAgentIds } : { action },
	};
}
