/**
 * Return a compact session identifier that is useful for humans.
 *
 * Session ids are UUIDv7 values. Their leading characters encode creation
 * time, so sessions created in the same millisecond can legitimately share
 * the first eight characters. The trailing characters are random and are a
 * better compact identifier for concurrently-created sessions.
 */
const UUID_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function shortSessionId(id: string): string {
    return UUID_SESSION_ID.test(id) ? id.slice(-8) : id;
}

/** Use the full, stable ID on a collision so it can also be resumed after a restart. */
export function uniqueShortSessionId(id: string, used: Iterable<string>): string {
	const base = shortSessionId(id);
	const usedIds = new Set(used);
	return usedIds.has(base) ? id : base;
}

/** Show a resumable ID even when two saved UUIDs share the compact suffix. */
export function displaySessionId(id: string, allIds: Iterable<string>): string {
	const base = shortSessionId(id);
	return [...allIds].some((other) => other !== id && shortSessionId(other) === base) ? id : base;
}
