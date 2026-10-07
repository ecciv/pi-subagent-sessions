export type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
};

/**
 * Normalize session collections across pi runtime adapters. Current runtimes
 * normally return arrays, while some adapters expose `{ entries: [...] }`.
 */
export function entryArray(value: unknown): any[] {
	if (Array.isArray(value)) return value;
	if (value && typeof value === "object") {
		const iterable = value as Iterable<unknown>;
		if (typeof iterable[Symbol.iterator] === "function") return Array.from(iterable);
		const nested = (value as { entries?: unknown }).entries;
		if (Array.isArray(nested)) return nested;
		if (nested && typeof (nested as Iterable<unknown>)[Symbol.iterator] === "function") {
			return Array.from(nested as Iterable<unknown>);
		}
	}
	return [];
}

export function sessionEntries(session: { sessionManager?: { getEntries?: () => unknown }; messages?: unknown }): any[] {
	const entries = session.sessionManager?.getEntries?.();
	return entryArray(entries ?? session.messages);
}

export const SUBAGENT_OWNER_CUSTOM_TYPE = "subagent-owner";

export function parentSessionIdFromEntries(entries: unknown): string | undefined {
    for (const entry of entryArray(entries).reverse()) {
        if (entry?.type !== "custom" || entry.customType !== SUBAGENT_OWNER_CUSTOM_TYPE) continue;
        const parentSessionId = entry.data?.parentSessionId;
        if (typeof parentSessionId === "string" && parentSessionId.length > 0) return parentSessionId;
    }
    return undefined;
}

export function subagentReportIdsFromEntries(entries: unknown): Set<string> {
	const ids = new Set<string>();
	for (const entry of entryArray(entries)) {
		const message = entry?.type === "message" ? entry.message : undefined;
		const customType = entry?.customType ?? (message?.role === "custom" ? message.customType : undefined);
		const details = entry?.details ?? message?.details;
		const isReportMessage =
			(entry?.type === "custom_message" || message?.role === "custom") && customType === "subagent-report";
		const isWaitResult =
			(message?.role === "toolResult" || entry?.role === "toolResult") &&
			(message?.toolName ?? entry?.toolName) === "subagent" && details?.action === "wait";
		if (!isReportMessage && !isWaitResult) continue;
		const reportIds = Array.isArray(details?.agents) ? details.agents : details?.reportAgentIds;
		if ((!isReportMessage && !isWaitResult) || !Array.isArray(reportIds)) continue;
		for (const id of reportIds) {
			if (typeof id === "string" && id.length > 0) ids.add(id);
		}
	}
	return ids;
}

export function emptyUsage(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
}

export function addUsage(target: UsageTotals, usage: any): void {
    if (!usage) return;
    target.input += Number(usage.input ?? 0);
    target.output += Number(usage.output ?? 0);
    target.cacheRead += Number(usage.cacheRead ?? 0);
    target.cacheWrite += Number(usage.cacheWrite ?? 0);
    target.total += Number(usage.totalTokens ?? usage.total ?? 0);
    const cost = usage.cost;
    target.cost += Number(typeof cost === "number" ? cost : cost?.total ?? 0);
}

export function usageFromEntries(entries: unknown): UsageTotals {
    const usage = emptyUsage();
    for (const entry of entryArray(entries)) {
        if ((entry?.type === "compaction" || entry?.type === "branch_summary") && entry.usage) {
            addUsage(usage, entry.usage);
            continue;
        }
        const message = entry?.type === "message" ? entry.message : entry;
        if (message?.role === "assistant" || message?.role === "toolResult") addUsage(usage, message.usage);
    }
    return usage;
}

export function usageFromSession(session: {
    getSessionStats?: () => { tokens?: Partial<UsageTotals>; cost?: number } | undefined;
    sessionManager?: { getEntries?: () => unknown };
    messages?: unknown;
}): UsageTotals {
    const stats = session.getSessionStats?.();
    const tokens = stats?.tokens ?? {};
    const statsUsage: UsageTotals | undefined = stats ? {
        input: Number(tokens.input ?? 0),
        output: Number(tokens.output ?? 0),
        cacheRead: Number(tokens.cacheRead ?? 0),
        cacheWrite: Number(tokens.cacheWrite ?? 0),
        total: Number(tokens.total ?? 0),
        cost: Number(stats.cost ?? 0),
    } : undefined;

    if (statsUsage?.cost) return statsUsage;

    const entries = session.sessionManager?.getEntries?.();
    const sessionUsage = usageFromEntries(entries);
    const messageUsage = usageFromEntries(session.messages);
    if (sessionUsage.cost !== 0) return sessionUsage;
    if (messageUsage.cost !== 0) return messageUsage;
    if (statsUsage && statsUsage.total !== 0) return statsUsage;
    if (sessionUsage.total !== 0) return sessionUsage;
    return messageUsage;
}
