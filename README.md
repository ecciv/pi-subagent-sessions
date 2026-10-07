# pi-subagent-sessions

This Pi package adds one LLM tool, `subagent`, and the `/subagents` interactive manager. Child sessions are persistent, scoped to their parent session, and resumable.

## Install

After the package is published, install it with:

```sh
pi install npm:pi-subagent-sessions
```

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
{"action":"wait"}
{"action":"wait","id":"<id>"}
{"action":"start","id":"<old-id>","task":"Continue from the saved session"}
```

Use `{"action":"start","id":"<id>","task":"..."}` to resume a saved/completed child and send it new work. `task` is the instruction for `start`; `message` is only for queueing a follow-up to an active child and does not resume a completed session. A `wait` on an already completed child only retrieves its available report—it does not restart the child.
A `start` call with a task waits until that child fully finishes by default. Use `{"action":"wait"}` to block for one or all active children; it returns their reports to the LLM. An unscoped wait also recovers unreported completed/saved child results belonging to this foreground session, even when other children are still active. If a saved child produced no assistant report, the manager includes a bounded transcript excerpt. A wait call does not end the foreground LLM turn. Set `"wait": false` on start for non-final launches, then call `wait` before continuing with unrelated work or giving a final answer. Do not use shell sleeps or status polling.

Use the tool only when the user explicitly requests delegation. Subagent reports are delivered to the main agent as batched participant messages containing assistant text only. Child thinking, tool calls, and tool results are not delivered to the main agent. A whole report batch is capped at 40,000 UTF-8 bytes; omitted text remains in the saved child transcript.
In print/JSON one-shot mode, the foreground waits for child settlement without making repeated LLM calls, then makes one report-triggered turn before exiting.

## `/subagents`

`/subagents` opens a live TUI overlay for active and saved sessions, with task and latest-activity previews, contextual actions, and preserved selection. Active transcripts follow new reports; press `t` to toggle thinking and `o` to expand/collapse tool details.


Saved child sessions are associated with the foreground Pi session that created them. The manager shows saved children for the current foreground session, rather than mixing in children from unrelated projects or sessions. Compact session IDs use the random UUID suffix so concurrently-created children remain distinguishable.
Resuming a saved child keeps its recorded model and thinking level unless you request an override. If the saved model is no longer available, resumption fails rather than silently switching models. Saved sessions from another foreground session cannot be resumed through this manager; an ambiguous compact ID must be replaced with its full ID.

Child usage uses Pi's aggregate session stats while a child is loaded and persisted entries for saved sessions, so completed and saved children remain included in the `children` and `combined` footer totals. Small dollar amounts are shown with extra precision instead of rounding down to `$0.0000`. Saved sessions display their recorded cost in the `/subagents` list.

## Configuration

Defaults can be overridden in `~/.pi/agent/subagents.json`:

```json
{
  "maxActive": 10,
  "progressTimeoutMs": 60000,
  "progressTokenThreshold": 30000,
  "progressMinTurns": 5,
  "progressRequestCooldownMs": 300000,
  "reportBatchWindowMs": 300,
  "maxReportCharacters": 12000,
  "allowExpensiveModels": false,
  "childTools": ["read", "bash", "edit", "write", "grep", "find", "ls"]
}
```

A progress request is queued as a steering message when a child turn exceeds the configured time or token threshold, but only after `progressMinTurns` child turns since the last report/request (default 5; set to 0 to disable the turn gate); the existing time cooldown still applies across turns. More expensive model/thinking overrides require interactive confirmation unless `allowExpensiveModels` is enabled; concurrent starts requesting the same override share one confirmation.

## Tests

Run the regression tests with Node 22+:
See [TESTING.md](TESTING.md) for the live Pi smoke-test procedure and cost-accounting checks.

```sh
node --experimental-strip-types --test test/*.test.ts
```
