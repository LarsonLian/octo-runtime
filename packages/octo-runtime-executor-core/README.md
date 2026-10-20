# Executor Core

`AgentExecutor` is the single transport-independent execution implementation. The
internal workspace package is private. Consumers of the distribution import
`@mininglamp-oss/octo-runtime/executor-core`.

## Integration Priority

Prioritize stability: the recommended integration is SDK access over IPC to an
independent Executor Kernel, especially for Electron and other long-running
hosts. The new Kernel's IPC and supervision implementation belongs to issue #47.
The existing isolated worker and stdio NDJSON path remain available meanwhile.

Direct Core embedding is an explicitly selected, simpler SDK integration option.
It shares the host process failure domain and requires the host to manage its
lifecycle. Publishing this entry point does not change the preference for isolated
execution. Both paths use the same AgentExecutor implementation.

The following example demonstrates the optional in-process integration:

```ts
import { AgentExecutor, type HostedAdapter } from "@mininglamp-oss/octo-runtime/executor-core";

export async function execute(adapter: HostedAdapter) {
  const executor = new AgentExecutor();
  executor.register(adapter);
  try {
    for await (const frame of executor.invokeFrames({
      inputs: [{ type: "text", text: "Inspect this workspace" }],
      contexts: {
        schema: "octo.context-envelope/v3",
        items: [
          {
            namespace: "octo.execution",
            name: "adapter",
            payload: { type: adapter.metadata.type }
          },
          { namespace: "octo.security", name: "approval_policy", payload: { mode: "full_access" } }
        ]
      }
    })) {
      console.log(frame);
    }
  } finally {
    const result = await executor.shutdown();
    if (result.cleanup === "incomplete") throw new Error("Executor cleanup remains incomplete");
  }
}
```

The host chooses, configures and registers its adapters. Construction and import
do not open IPC endpoints, install providers, load Extras, read a CLI manifest,
or register process signal handlers. Context rendering preserves the current
event's selected items; it does not recover or supplement business history.
Run version 7, Context v3 and Adapter protocol 2 remain independent.

## Execution API

- `register`, `list`, `describe`, `probe`: registration and explicit availability
  discovery. `list` returns metadata; `describe` performs bounded probes.
- `invoke`: defaults to native frames; explicit `protocol_mode: "canonical"`
  produces typed canonical events through the existing protocol view.
- `invokeFrames`: both modes as validated source `HostFrame`s with stable
  execution identity and monotonically increasing sequence numbers.
- `cancel`: requests cancellation by invocation ID; `true` does not confirm
  provider exit. `InvokeEnvironment.signal` is a local alternative.
- `respondInteraction` / `respondNative`: route responses to the active owner
  in the selected mode; provider adapters validate the original pending request,
  permissions, duplicate responses and transport delivery.
- `shutdown`: permanently closes admission and attempts bounded cleanup of all
  owned invocations. The owner must inspect the returned result.

Input preparation can reject synchronously. Identity, capacity and closed-state
checks occur at the first `next()`, before the running receipt becomes visible.
Catch errors around the entire consumption loop. Creating an iterator without
consuming it neither reserves capacity nor starts a provider. All submitted data
is snapshotted; signals stay local and trusted environment overrides and stream
budgets remain separate from model text. Defaults and mandatory constraints are
resolved once on the execution path.

After admission, cancellation owns the invocation even before provider startup.
An abandoned direct iterator must be closed with `return()` or cancelled; a
paused consumer does not imply cancellation. Kernel subscription disconnection
has different semantics and does not cancel its background source consumer.

## Shutdown and failure domain

`shutdown(reason?, timeoutMs = 2500)` synchronously blocks new registration and
admission. Concurrent calls share an attempt. The timeout must be a positive
safe integer. `ExecutorShutdownResult` is an immutable snapshot:

- `state: "closed"` means admission is closed.
- `cleanup: "complete"` means all cleanup observed by this Core has completed.
- `cleanup: "incomplete"`, `unresolvedInvocationIds` and
  `failedCleanupInvocationIds` retain unresolved ownership. A later `shutdown`
  waits again for pending cleanup without reopening execution or replaying any
  request. Failed or unverified cleanup stays incomplete: another iterator
  `return()` cannot retry a failed generator finalizer. A late completion of
  pending cleanup does not alter an earlier result.

The iterator contract provides no independent resource-disposal proof. A rejected
`next()` may originate in a failing finalizer, so Core conservatively retains
failed ownership even if a later `return()` resolves. A `return()` yielding
`done: false`, or an early close without `return()`, also cannot confirm cleanup.
Incomplete means cleanup is unconfirmed, not that a leak is proven. These records
remain within the 1024-entry bound and can exhaust admission; the owning host or
isolated worker must handle containment. Core does not retry the Run or scan
unowned processes to hide this state.

Closed admission does not authorize releasing a host's Home lock, nor prove that
arbitrary JavaScript or unowned descendants stopped. Adapter-owned process
cleanup stays with the adapter. A successful provider candidate is confirmed
only after stream and cleanup validation; cleanup failure cannot report success.

Provider terminal draining and iterator closure share one `cancelGraceMs` budget,
starting at the first accepted terminal, abort or cleanup request. The deadline
uses a monotonic clock. Catch/finally and resumed consumers use the remaining
budget; they do not grant another grace period. The explicit `shutdown` timeout
only bounds that caller's wait for owned cleanup, without resetting this deadline.

Direct calls share the host's process and event loop. Exceptions can fail an
invocation, but `process.exit`, OOM and synchronous blocking cannot be contained
by this Core. The default production worker and stdio NDJSON path remain in the
transitional adapter-host transport package. That worker instantiates this same
class; it does not retain a second executor. Kernel IPC, replay and supervision
belong to issue #47. Worker restart restores availability for subsequent work;
it never automatically replays interrupted Runs.

Invocation identity metadata is bounded to 1024 entries with lazy 120-second
eviction of inactive records. Active, paused or incompletely cleaned calls are
not evicted. There is no business database or replay buffer in Core. Explicit
`prepareInvokeInput`, `resolveLocalContext`, `localRuntimeLimits` and
`prepareRunContext` helpers remain available; workspace preparation is not
automatically added to every invocation.
