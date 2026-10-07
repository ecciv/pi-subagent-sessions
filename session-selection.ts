export type OwnedSession = { id: string; parentSessionId?: string };

/** Never resolve an identifier outside the current foreground session. */
export function selectOwnedSession<T extends OwnedSession>(
	sessions: readonly T[],
	id: string,
	parentSessionId: string,
): T | undefined {
	const owned = sessions.filter((session) => session.parentSessionId === parentSessionId);
	const exact = owned.filter((session) => session.id === id);
	if (exact.length === 1) return exact[0];
	if (exact.length > 1) return undefined;
	const matches = owned.filter((session) => session.id.startsWith(id) || session.id.endsWith(id));
	return matches.length === 1 ? matches[0] : undefined;
}
