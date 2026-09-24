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

## Live smoke test

1. Reload the extension in Pi after changing `index.ts` or any imported module. A running Pi process does not automatically use the edited extension.
2. Start a read-only worker **without an `id`**:

   ```json
   {
     "action": "start",
     "name": "extension-smoke-test",
     "task": "Inspect the repository and report the test command. Do not modify files, create branches, or use the network.",
     "thinking": "low"
   }
   ```

3. Immediately query status:

   ```json
   {"action":"status"}
   ```

   It should report the worker as `running`, and the foreground turn should remain available for another tool call.
   A `start` call that includes a task waits internally for the first child report (or child settlement) and then hands control back. Do not add a bash sleep/poll loop. `status` remains an immediate inspection operation.
   If launching agents sequentially, use `wait:false` for non-final starts and leave it unset for the final start. If issuing multiple start calls in one assistant turn, they wait for the first report as a batch.
4. Query status again after the worker reports completion. It should report `done` and no `entries is not iterable` or `getEntries` error should appear.
5. Confirm the worker report says that no files or branches were changed.

For a new worker, omit `id`. Supplying `id` to `start` means resume an existing saved session and may correctly produce `Unknown subagent session` for an unknown ID.

## Cost-accounting check

For a session that has compacted or branched, compare the Pi footer cost with the subagent widget's combined cost. They should include assistant messages, tool results, compaction entries, and branch-summary entries. Child usage must still work when the runtime child session has no `sessionManager` property.

## Provider requirements

The live smoke test requires a configured provider/model. A failure such as `No API key found for ...` is an environment/authentication failure, not an extension lifecycle failure. Configure the provider or use a configured model before diagnosing the extension.

Model overrides are resolved against the runtime's authenticated/available models. If multiple providers expose the same model ID, an unqualified name prefers the foreground agent's provider; use `provider/model` to select a provider explicitly.
