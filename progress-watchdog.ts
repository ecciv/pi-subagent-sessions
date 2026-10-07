export type ProgressWatchdogInput = {
	triggerReached: boolean;
	turnCount: number;
	lastReportTurn: number;
	lastWatchdogTurn: number;
	minTurns: number;
	lastWatchdogAt?: number;
	now: number;
	cooldownMs: number;
};

/** Allow a progress nudge only after the configured turn gap and time cooldown. */
export function shouldRequestProgress(input: ProgressWatchdogInput): boolean {
	if (!input.triggerReached) return false;
	const lastProgressTurn = Math.max(input.lastReportTurn, input.lastWatchdogTurn);
	if (input.turnCount - lastProgressTurn < Math.max(0, input.minTurns)) return false;
	if (input.lastWatchdogAt !== undefined && input.now - input.lastWatchdogAt < input.cooldownMs) return false;
	return true;
}
