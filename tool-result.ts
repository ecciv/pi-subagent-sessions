export function subagentToolResult(text: string, action: string): {
	content: [{ type: "text"; text: string }];
	details: { action: string };
} {
	return {
		content: [{ type: "text", text }],
		details: { action },
	};
}
