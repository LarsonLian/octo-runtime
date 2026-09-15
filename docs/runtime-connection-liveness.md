# Runtime Connection Liveness

The default Worker advertises a 30-second heartbeat cadence. Harness sends
`runtime.heartbeat` on that cadence; heartbeat ACKs are not proof of a new
database write. Worker may acknowledge from memory between its 120-second
persistence intervals.

Harness independently terminates a WebSocket after 60 seconds without any
server message. This receive watchdog also covers a socket that opened but
never received `runtime.welcome`. Every inbound message resets the timer;
outbound heartbeats do not. The timer is cleared on disconnect or shutdown.
Embedders can override `AgentWorkRuntimeOptions.receiveTimeoutMs` when using a
different server heartbeat cadence.

Timeout enters the existing automatic reconnect loop, using the configured
load-balanced endpoint, device credential, and runtime ID. It does not enroll a
new device. Reconnect registration still writes to the Worker database, and
unacknowledged outbox events retain the existing replay behavior.

Worker database stale detection is independent of this local watchdog. With a
120-second persistence interval and 300-second DB stale TTL, healthy replicas
can continue to use persisted readiness between heartbeat writes. If reconnect
never succeeds after a Worker pod failure, DB stale cleanup is delayed until
the stale TTL and reconciliation schedule permit it. All Worker replicas must
use consistent presence settings.
