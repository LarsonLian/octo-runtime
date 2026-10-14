# Runtime Connection Liveness

Date: 2026-10-14. This describes the current optional worker-access implementation, not the final device connection contract. See [Runtime local/online contract](runtime-local-and-online-contract.md).

## Scope

HostApp explicitly enables the Worker module before registration and connectivity are relevant. A local Runtime retains its identity and remains usable through local IPC when that module is disabled, registration fails or the connection drops. IM has independent configuration and liveness.

Registration ACK, module startup acceptance and a historical connected value do not prove continuing device presence. Health reports actual module state separately from local readiness.

## Current Receive Watchdog

worker-access defaults to a 60-second receive timeout. Every inbound server message resets the watchdog; outbound heartbeat sends do not. It also detects an opened socket that never receives runtime.welcome. The timer is cleared on disconnect or shutdown.

The heartbeat interval is taken from the current welcome payload, with a 30-second fallback. Direct users can supply `AgentWorkRuntimeOptions.receiveTimeoutMs` when an explicitly configured service needs a different cadence.

After timeout, an enabled module uses its existing reconnect logic and saved Runtime identity. It does not initialize a new local Runtime as a connectivity repair. Stopping the module stops its connection attempts while preserving the shared local Host.

## Persistence And Pending Contract

The current event relay is a bounded process-local window, not a durable outbox or a guarantee of replay after restart. Server presence persistence and stale cleanup are separate concerns; their policies belong to current Worker configuration, not local startup readiness.

Final access registration responsibilities, device WS/heartbeat ownership, offline invalidation and the persisted Work App online switch are pending review or implementation. Current watchdog behavior is implementation evidence, not approval of that final architecture.
