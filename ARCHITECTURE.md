# Architecture

The function-based Extra loader is implemented alongside the existing modules. A package declares a stable name and a lambda `(ctx, config) => void | Promise<void>`; its scope owns disposal callbacks and uses the shared Host. CLI startup reads explicitly enabled JSON declarations, while SDK hosts supply their own objects. See [Extra design and scenarios](docs/extra-plugins.md). Existing channel-im and worker-access have not yet migrated to this contract.

Octo Runtime is a provider-neutral local Agent Runtime. A locally initialized Runtime has its own stable identity whether or not HostApp registers it or permits online access. Cloud registration, device connectivity and IM connectivity are optional integrations, not local execution prerequisites.

The current normative package and state contract is [Runtime local existence and optional online access](docs/runtime-local-and-online-contract.md). This document describes the current implementation; pending changes are explicitly identified there.

## Local Execution

```text
HostApp business request
  -> octo-runtime-daemon local SDK
  -> local control IPC
  -> shared HostRunService / adapter-host
  -> Provider Adapter
  -> already installed Provider
```

The independent embedded package has been removed. Its local identity, Home, supervision and stream APIs now live in the daemon package. The current SDK still starts a daemon package control process. Removal of a package layer does not establish a separate cloud-only process.

HostApp selects the subject and tenant profiles, installation plan, execution target, business defaults/mandatory and current Context. SDK startup creates or reads local Runtime identity without Human Token, enrollment or Worker availability. Valid IPC readiness establishes local readiness; a socket file alone does not.

## Optional Integrations

```text
HostApp explicitly enables module
  -> daemon loads factory and supplies shared Host
  -> channel-im: IM connection and message handling
  -> worker-access: current enrollment + Worker WS + remote execution
```

daemon has no production dependency on either optional package. Module descriptors do not load or connect their factories. Explicit start activates one module; stopping it preserves local execution. A module startup ACK means acceptance, not successful registration or connectivity.

The [second architecture review](../docs/architecture-review-2-device-extra-2026-10-14.md) sets the target: function-based extra packages own external business integrations, with Octo and WeCom in separate packages. The final allocation of registration, device heartbeat and remote execution remains pending review. The current module API and worker-access implementation must not be presented as that completed architecture.

## Ownership

| Concern | Owner |
| --- | --- |
| Runtime installation, versions and enabled integrations | HostApp |
| Business Agent definitions, target, five-tuple and defaults/mandatory | Business producer |
| Local identity and runtime/module lifecycle | daemon SDK and package |
| Provider invocation, interaction, cancellation and source events | Shared Host / Adapter |
| Local conversation history and Provider session binding | HostApp business storage |
| Registered Runtime authorization and optional remote execution control | Worker, within its current contract |
| IM addressing, channel sessions and message delivery | Channel integration and its business layer |

Remote execution retains identity, authorization, lease and fencing validation. These are not prerequisites for direct local invocation. Runtime ID is not Agent ID or a credential; Home-level machine ID is an untrusted installation grouping label.

## Context And Sessions

Run remains `schema_version=7`; Context remains `octo.context-envelope/v3`. The Event producer chooses the content, order and timing of each model context snapshot, including empty or explicitly repeated items. Execution configuration is independently validated and does not enter model text.

Worker, SDK, daemon, Host and Adapter validate and forward the current snapshot. They do not supplement, merge, deduplicate or suppress model context using session IDs, hashes or previous runs. Host only renders allowlisted namespace/name patterns in order. See [Context rules](docs/context-llm-injection.md) and [IPD-SE](../docs/event-context-rendering-ipd-se.md).

Provider session data is opaque. Its presence does not prove resume success. After reset, a new Provider session or failed recovery, the business producer decides and supplies necessary background again; the execution layer reports the real outcome.

## Streams And Recovery

Host source streams and the current remote relay use bounded memory. They are not a durable outbox or a complete conversation archive. Applications persist complete events and business history as needed. Resume uses the original run/stream cursor; gaps and expired streams fail explicitly without a second invocation.

Command or module acceptance does not prove execution completion. Consumers observe the actual terminal event; cancellation acceptance also requires a final outcome. Cloud connectivity does not prove output persistence or business delivery.

The Core/SQLite reference engine remains useful for local diagnostics and tests. It does not make Worker a universal authority over local conversations or business Agent definitions.

## Installation And Security

HostApp alone decides whether and how to install Runtime and Provider dependencies. Execution layers may perform an explicitly selected plan; missing dependencies return a concrete status without implicit downloads.

Credentials stay in protected host/profile storage and outside renderer, model text, public logs, argv and service definitions. A workdir is a Provider cwd, not an OS sandbox. Mutually untrusted users need an appropriate OS security boundary.

See [integration](INTEGRATION.md), [deployment](DEPLOYMENTS.md), [operations](docs/07-operations.md) and [verified implementation scope](docs/validation/daemon-package-modules-2026-10-14.md).
