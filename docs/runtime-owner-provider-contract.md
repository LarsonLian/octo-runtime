# Runtime Owners and Provider Discovery

This contract is a breaking reset. There is no legacy schema or string-adapter
upgrade support. The Worker owns fresh-schema creation; never reset Octo/auth
or Gateway databases as part of a Runtime reset.

## Local Existence And Optional Cloud Binding

The daemon SDK initializes a stable local Runtime ID before enrollment. Local IPC execution does not need a Human Token, cloud owner record or Runtime credential. Registration and reconnection reuse that ID; failed cloud access does not remove it. See [local/online contract](runtime-local-and-online-contract.md).

The following owner/provider rules govern enabled cloud registration and discovery, not local Runtime existence or startup. Cloud registration reports an authorized view of an existing local object.

## Local Binding

Each profile persists its local `runtime_id` and tenant binding in
`identity/runtime.json`; enabled enrollment adds credential binding metadata. Credentials remain in the protected credential file.
Harness deliberately does not persist `owner_subject_type`, `owner_subject_id`,
or `created_by_octo_uid`: Worker binds those fields to the Runtime credential and
uses them for authorization and audit. They are not required to register or
connect a Runtime.

Space is the tenant isolation boundary; owner is a separate user/organization
subject. An owner may have many Runtimes, and one Home installation's
`machine_id` may be shared by many profile Runtimes.

## Profile Name Binding

The breaking `feat/runtime-profile` contract requires `profile` on both
`POST /v1/runtimes/enroll` and `POST /v1/runtime/register`. Harness sends the
selected local profile name automatically, including `default`. Names are
1-128 ASCII characters, starting with a letter/digit; remaining characters may
also be `.`, `_`, `-`. Harness Home infrastructure names remain reserved.
Worker stores `profile VARCHAR(128) NOT NULL` and returns it on Runtime queries.

Harness stores the returned profile in `identity/runtime.json` as the binding
snapshot; it must exactly match the existing profile configuration/directory.
Missing/mismatched profiles in local identity or server responses are rejected,
not inferred or upgraded. Same-grant retries and credential-proven renewals must
keep the exact profile. Registration cannot rename it; a profile mismatch
fails closed before connecting. Renaming requires a newly enrolled profile.

Profile is client-reported metadata, not authority or a globally unique key.
Do not add `(machine_id, profile)` uniqueness: different Homes may share names.
Consumers can display `MacBook / work` versus `MacBook / personal`, keeping the
Runtime ID for duplicate labels. Hostname and Runtime name stay unchanged.
No compatibility upgrade is shipped. Any explicitly authorized schema reset has its own target list; ordinary startup, credential renewal and reconnect preserve local Runtime identity. Do not infer a database or Home reset from this contract.

An enrollment's authorized owner is server-controlled.
`POST /v1/runtime_enrollments` accepts optional `kind` and
`owner_subject_type`.
Missing `owner_subject_type` defaults to `user`; for a user owner,
`owner_subject_id` must be omitted and Worker derives it from the verified Octo
UID. Organization ownership requires an explicit `owner_subject_id`. Worker
always derives `created_by_octo_uid` from the verified user. Re-enrollment cannot
change an existing Runtime's Space or owner.

The human issuer may send
`{"kind":"cloud","owner_subject_type":"organization","owner_subject_id":"engineering"}`
to `POST /v1/runtime_enrollments`; missing kind defaults to `local`. The
enrollment selects the server-side Runtime kind. Harness metadata registration
does not rewrite it, so a cloud Runtime remains cloud after login/reconnect.
Re-enrollment requires a grant with matching kind.

## Device Metadata

Runtime registration reports display-ready, non-authoritative device metadata.
`device.os` includes the product/distribution version and kernel release when
available, while `device.arch` includes the machine architecture and CPU model.
For example, a macOS Runtime may report `macOS 26.0.1 (Darwin 25.0.0)` and
`arm64 / Apple M3 Pro`. The CLI enrollment check and daemon reconnect use the
same collector. Each value remains within the Worker's existing 64-character
limit; identity and authorization must never depend on these fields.

## Adapter Objects

The daemon reports provider objects rather than names:

```json
{
  "capabilities": {
    "adapters": [
      {
        "provider_type": "codex",
        "provider_version": "1.2.3",
        "provider_path": "/usr/local/bin/codex",
        "available": true,
        "unavailable_reason": null,
        "capabilities": ["session.serialize"],
        "process_model": "app_server",
        "transport": "stdio"
      },
      {
        "provider_type": "claude-code",
        "provider_version": null,
        "provider_path": null,
        "available": false,
        "unavailable_reason": "command_not_found",
        "capabilities": []
      }
    ]
  }
}
```

Paths and versions here are examples. The adapter host probes the actual
provider executable with bounded `--version` output and timeout, never a shell
command. It reports absolute discovered paths and provider versions, not adapter
package versions. Unavailable providers remain visible with `available: false`;
unknown metadata is `null`. `unavailable_reason` identifies missing commands or
failed/missing/timed out probes without exposing exception messages. Probe failures do not prevent other adapters from
loading. Unprobed adapters are not advertised as available. Discovery runs via
the existing adapter-host RPC boundary, not by spawning providers in the daemon.
Configured Provider connections are probed periodically with their Runtime-local settings; OpenClaw probe and execution read the same profile connection. Restart the daemon to refresh other installed metadata. Executable availability is
not proof of provider authentication or successful execution.

Worker registration rejects string lists, and readiness only accepts a matching
`provider_type` with `available: true`. This remote routing check is not a local IPC readiness requirement. Local paths are descriptive, potentially sensitive metadata and are
never commands for the Worker to execute.

OpenClaw follows the same Runtime ownership and routing contract. See [Runtime 与 OpenClaw 连接统一合同](15-openclaw-external-agent-binding-design.md) for local connection sources, credentials and Context target selection.
