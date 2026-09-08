# Transport And Multi-node

The multi-node contract keeps one authority: Agent Worker owns AgentSession,
AgentRun, placement, lease and fencing. Harness nodes are replaceable executors.

```text
business scheduler -> Agent Worker -> authenticated WSS -> Harness Runtime
                                     <- ACK / events ----
```

## Downlink

`run.start` carries a frozen execution envelope containing `run_id`,
`agent_session_id`, Agent revision, AgentRun request, lease/fencing metadata and
optional opaque provider session. `run.cancel` addresses the Worker Run ID.

A command ACK only means the runtime durably accepted the command. Duplicate
commands must return the same acceptance result and never start a second
invocation.

## Uplink

`run.event` carries `run_id`, monotonic `seq`, stable event ID and canonical
event. Worker returns cumulative received and durable ACKs. Harness retains outbox
rows until durable ACK and replays them after reconnect.

## Placement And Recovery

- Worker chooses an eligible Runtime and owns lease expiration.
- fencing prevents an obsolete Runtime from committing events after reassignment.
- Runtime hello reports active Run IDs for reconciliation.
- Same AgentSession is serialized by Worker.
- Provider session stays on Worker AgentSession and follows the next valid lease.
- Lost local processes are not silently resumed; Worker decides terminalization
  or reassignment.

Loop, AutoPilot, Webhook and IM schedulers never connect directly to a Harness
node. They submit AgentRuns to Worker, which keeps routing and execution lifecycle
independent from business scheduling.
