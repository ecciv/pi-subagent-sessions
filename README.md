# Subagent manager

This extension adds one LLM tool, `subagent`, and the `/subagents` interactive manager.

The manager keeps child sessions under:

```text
~/.pi/agent/subagents/<project>/
```

These files are intentionally separate from normal Pi sessions. Child agents receive the normal coding tools, but no extensions and no `subagent` tool, so they cannot recursively create or manage agents.

## Tool actions

```json
{"action":"start","name":"reviewer","task":"Review the authentication changes"}
{"action":"message","id":"<id>","message":"Focus next on the token refresh path"}
{"action":"status"}
{"action":"status","id":"<id>"}
{"action":"stop","id":"<id>"}
{"action":"start","id":"<old-id>","task":"Continue from the saved session"}
```

A `start` call with a task waits for the first child report before handing control back, so the coordinator should not use shell sleeps or status polling. Set `"wait": false` for non-final sequential launches; omit it for the final launch. Multiple parallel starts can wait as one batch.

Use the tool only when the user explicitly requests delegation. Subagent reports are delivered to the main agent as concise, batched participant messages containing assistant text only. Child thinking, tool calls, and tool results are not delivered to the main agent.
In print/JSON one-shot mode, the manager keeps the foreground process alive with hidden wait turns while child agents are active. It only allows Pi to exit after all child agents have reached a terminal state and their final reports have been delivered.

## `/subagents`

`/subagents` opens a TUI overlay for active and saved sessions. It supports transcript viewing, queued user messages, stopping active agents, and resuming saved sessions. The default transcript view is compact; the detail view can show the full child session.


Saved child sessions are associated with the foreground Pi session that created them. The manager shows saved children for the current foreground session, rather than mixing in children from unrelated sessions in the same project. Each session uses the first eight characters of its UUID consistently in the UI.

Child usage is calculated from persisted session entries, so completed and saved children remain included in the `children` and `combined` footer totals. Saved sessions display their recorded cost in the `/subagents` list.
## Configuration

Defaults can be overridden in `~/.pi/agent/subagents.json`:

```json
{
  "maxActive": 10,
  "progressTimeoutMs": 60000,
  "progressTokenThreshold": 30000,
  "progressRequestCooldownMs": 300000,
  "reportBatchWindowMs": 300,
  "maxReportCharacters": 12000,
  "allowExpensiveModels": false,
  "childTools": ["read", "bash", "edit", "write", "grep", "find", "ls"]
}
```

A progress request is queued as a steering message when a child turn exceeds the configured time or token threshold. More expensive model/thinking overrides require interactive confirmation unless `allowExpensiveModels` is enabled.

## Tests

Run the standalone session-data tests with Node 22+:
See [TESTING.md](TESTING.md) for the live Pi smoke-test procedure and cost-accounting checks.

```sh
node --experimental-strip-types --test test/*.test.ts
```
