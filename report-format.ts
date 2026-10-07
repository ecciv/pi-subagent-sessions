export const MAX_REPORT_BATCH_BYTES = 40_000;

type ReportLike = { agent: { name: string; shortId: string }; text: string };

function utf8Prefix(text: string, maxBytes: number): string {
	const characters = Array.from(text);
	let low = 0;
	let high = characters.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(characters.slice(0, middle).join(""), "utf8") <= maxBytes) low = middle;
		else high = middle - 1;
	}
	return characters.slice(0, low).join("");
}

/** Bound the *whole* message sent to the foreground model, not only each child report. */
export function formatReportBatch(reports: readonly ReportLike[]): string {
	let result = "";
	for (let index = 0; index < reports.length; index++) {
		const { agent, text } = reports[index];
		const prefix = `${index === 0 ? "" : "\n\n---\n\n"}[${agent.name.slice(0, 80)} ${agent.shortId.slice(0, 40)}]\n`;
		// Reserve room for an omission notice and share the remaining bytes fairly.
		const available = Math.floor((MAX_REPORT_BATCH_BYTES - Buffer.byteLength(result) - Buffer.byteLength(prefix) - 140) / (reports.length - index));
		if (available < 100) {
			result += `\n[${reports.length - index} additional reports omitted; see saved child transcripts.]`;
			break;
		}
		const notice = "\n[Report truncated; full text is in the saved child transcript.]";
		const body = Buffer.byteLength(text) <= available ? text : utf8Prefix(text, available - Buffer.byteLength(notice)) + notice;
		result += prefix + body;
	}
	return result;
}
