# Octo Harness Apps

`apps/` contains executable assembly points; reusable protocols and adapters live
under `packages/`.

| App | Responsibility |
|---|---|
| `cli` | local daemon status, adapter, log and reference Run inspection |
| `daemon` | Agent Worker WSS Runtime, reliable outbox and local Unix socket |
| `adapter-host` | dynamic adapter loading and stdio NDJSON JSON-RPC |

Production execution is initiated by Agent Worker:

```text
business service -> Agent Worker AgentRun -> daemon -> adapter-host -> provider
                                                <- canonical run events <-
```

The CLI does not create Agent, Chat, Task or Trigger objects. Use Agent Worker
OpenAPI/`octo-cli harness` for production AgentRun submission, AgentSession reset,
status and cancellation. Local commands only inspect the current daemon:

```bash
pnpm cli status
pnpm cli adapter list
pnpm cli logs query <agent-run-id>
pnpm cli agent-session list
pnpm cli agent-run events <agent-run-id>
```
