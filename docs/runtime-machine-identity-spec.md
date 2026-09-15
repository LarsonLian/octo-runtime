# Runtime and Machine Identity

The subsequent [owner/provider contract](runtime-owner-provider-contract.md)
replaces Runtime tenant/subject fields with octo_space_id/owner_ref and adapter
name lists with provider objects.

- Breaking reset only; no legacy identity compatibility is required.
- Each profile stores the server-generated runtime_id and credential_id. Remove system_id and device_id.
- Persist one machine_id in <home>/machine.json, shared across all profiles. This is an untrusted installation grouping label, never an authentication key.
- Same-machine profiles in the same Space or different Spaces must retain separate Runtime identities and credentials.
- Ordinary login, restart, registration, and reconnect reuse Runtime identity. Ordinary login does not enroll again.
- Enrollment grant retries are idempotent. Renewal with a new grant sends the saved runtime_id and proves possession of its Runtime credential; authorized user, Space, and machine binding must match.
- Credentials stay in protected profile files and must not enter argv, service definitions, environment variables, logs, or provider input.
- Preserve connection recovery, durable outbox, and AgentSession/AgentRun semantics.
- Use branch feat/runtime-machine-identity and review against the pre-change HEAD; fix actionable findings.
- No online E2E or deployment changes. Reset only the local Worker database with a recovery backup.

## Contract

Exchange octo_enroll_ at POST /api/v1/runtimes/enroll using machine_id, required profile (1-128 characters), and optional runtime_id plus X-Runtime-Token. Retries/renewals must match the enrolled profile exactly.
The response contains runtime and credential; use the octo_runtime_ credential to refresh registration and connect.
Registration also requires profile. Store the returned profile in the identity binding and reject local/server mismatches rather than upgrading old identities. This subsequent breaking change uses branch `feat/runtime-profile`.
Keep <home>/<profile>/identity/runtime.json and <home>/<profile>/credentials/runtime-token.json separate from the Home-global machine label.
