export function terminalReport(record: {
	status: "running" | "stopping" | "done" | "stopped" | "error";
	lastError?: string;
	errorReported: boolean;
	instructionCount: number;
	reportCount: number;
	reportCountAtRunStart: number;
}): string | undefined {
	if (record.status === "stopping" || record.status === "stopped") return undefined;
	if (record.status === "error" && !record.errorReported) {
		return `Subagent failed: ${record.lastError ?? "unknown error"}`;
	}
	if (record.instructionCount > 0 && record.reportCount === record.reportCountAtRunStart) {
		return `Subagent ${record.status} without an assistant report. Inspect the saved child transcript for details.`;
	}
	return undefined;
}
