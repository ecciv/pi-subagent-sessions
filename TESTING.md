# Testing the subagent extension

The extension has two testing layers: local regression tests and a live smoke test in Pi.
Run both after changing subagent lifecycle, session accounting, tool results, or configuration.

## Local regression tests

Use Node 22 or newer:

```sh
node --experimental-strip-types --test test/*.test.ts
node --experimental-strip-types --check index.ts
git diff --check
```

The tests cover:

- session entries returned as arrays, iterables, or `{ entries: [...] }`
- agent sessions that do not expose `sessionManager`, using `messages` as a fallback
- assistant, tool-result, compaction, and branch-summary usage accounting
- malformed or missing session collections
- subagent tool results not terminating the foreground turn
- owner-scoped saved ID resolution, compact-ID collisions, and resume settings
- one-shot event-driven report draining and aggregate report-size limits
- cancellation and event-driven waits that ignore progress reports until all selected children settle

## Automated Pi TUI integration test

This launches a real Pi TUI in an isolated tmux session, instructs the coordinator to start one subagent that runs a harmless `printf` command, waits for the finished response, captures the visible TUI text and screenshot, and copies both JSONL session files into the run artifacts directory.

Requirements: Pi installed and authenticated, `tmux`, and Node 22+. Run from the repository root:

```sh
node integration/pi-tui-subagent.mjs
```

Artifacts are written under `artifacts/pi-subagent-integration/<run-id>/` (ignored by Git): `main-session.jsonl`, `child-session.jsonl`, `assistant-result.txt`, `tui-visible.txt`, `tui-history.txt`, `tui-screen.ansi`, and `screenshot.svg` (plus `screenshot.png` when libcairo is installed). The integration test prints the exact artifact directory. The sessions are copies of the original Pi JSONL files and can be inspected or reopened with Pi.

Override the model/provider with `PI_SUBAGENT_TEST_PROVIDER` and `PI_SUBAGENT_TEST_MODEL`, the output directory with `PI_SUBAGENT_TEST_OUTPUT`, or the timeout with `PI_SUBAGENT_TEST_TIMEOUT_MS`. This makes real model calls and incurs provider cost.

## Live smoke test

1. Reload the extension in Pi after changing `index.ts` or any imported module.
2. Start a read-only worker **without an `id`**, setting `wait:false` so status can be inspected during its run:

   ```json
   {
     "action": "start",
     "name": "extension-smoke-test",
     "task": "Inspect the repository and report the test command. Do not modify files, create branches, or use the network.",
     "thinking": "low",
     "wait": false
   }
   ```

3. While it is running, call `{"action":"status"}`. A sufficiently short task might finish before this call; otherwise it should appear as `running`. Avoid shell sleeps and polling.
4. After the report, call `{"action":"status","id":"<short-id-from-start>"}`; this should show `done`. Status without an ID lists **only running** children. `/subagents` lists saved children after a restart.
5. Confirm the worker report says that no files or branches were changed. Also exercise a default (`wait` omitted) start: its tool result should not return until that child is finished. Launch with `wait:false`, then call `{"action":"wait"}`; it should wait for active children, return their reports, and let the foreground LLM continue. For saved-result recovery, let a child finish, reload/restart Pi on the same foreground session before its report is delivered, then call `wait` with no ID; it should recover the report from the saved child transcript. Confirm the resulting wait report is not replayed on a second call.
6. In print/JSON mode, start a worker and check that the final report and foreground summary arrive without repeated hidden wait turns.
7. After restarting Pi on the **same foreground session**, resume a saved child using the short ID. Verify that its saved model/thinking level is retained. A child ID from another foreground session must be rejected.
8. With an intentionally unavailable credential (or a mocked failing provider), confirm the coordinator receives a terminal failure report even when the child emits no assistant text.

For a new worker, omit `id`. Supplying `id` to `start` means resume an existing saved session and may correctly produce `Unknown subagent session` for an unknown ID. For `wait`, omit `id` to wait for all active children or supply one to wait for a specific child.

## TUI smoke check

While at least one child is running, open `/subagents` and verify:

- The row shows its task, model, elapsed time, usage, and latest activity; it updates while the overlay remains open.
- Selection remains on the same session after opening/closing a transcript or returning from an action.
- Active sessions offer message/stop actions, while saved sessions offer resume; `v`, `m`, `s`, `r`, and `b` shortcuts match the visible actions.
- The transcript wraps long and multiline content, follows new activity at the bottom, and keeps its scroll position when reading older content.
- `t` toggles thinking and `o` toggles tool details; arrow, page, home, and end keys scroll correctly.
- The list and transcript remain usable in a short/narrow terminal.

## Cost-accounting check

For a session that has compacted or branched, compare the Pi footer cost with the subagent widget's combined cost. They should include assistant messages, tool results, compaction entries, and branch-summary entries. Child usage must still work when the runtime child session has no `sessionManager` property.

## Provider requirements

The live smoke test requires a configured provider/model. A failure such as `No API key found for ...` is an environment/authentication failure, not an extension lifecycle failure. Configure the provider or use a configured model before diagnosing the extension.

Model overrides are resolved against the runtime's authenticated/available models. If multiple providers expose the same model ID, an unqualified name prefers the foreground agent's provider; use `provider/model` to select a provider explicitly.
