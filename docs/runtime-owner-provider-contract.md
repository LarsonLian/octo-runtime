# Runtime Owners and Provider Discovery

This contract is a breaking reset. There is no legacy schema or string-adapter
upgrade support. The Worker owns fresh-schema creation; never reset Octo/auth
or Gateway databases as part of a Runtime reset.

## Profile Binding

Each profile persists `runtime_id`, `credential_id`, `octo_space_id`, and
`owner_ref` in `identity/runtime.json`. Profile configuration uses
`octo_space_id` and `owner_ref`, not `tenant_id` or `subject_id`. Credentials
remain in the protected credential file.

Examples: `uid:alice`, `uid:cec02bd6ad8f4d29bf84e7a7e8e35b54`,
`org:engineering`. Space is the tenant isolation boundary; owner is a separate
user/organization reference. An owner may have many Runtimes, and one Home
installation's `machine_id` may be shared by many profile Runtimes.

No `created_by_uid` or initial enrollment pointer is added; operation history
will belong to a future audit table. An enrollment's authorized owner is
server-controlled. Human enrollment requires no request body and derives
`uid:{verified UID}` from octo-auth; it ignores any client ownership assertions.
Until Octo provides organization authority, the service and credential model
can carry verified organization grants without treating Space membership as
organization permission. Re-enrollment cannot change an existing Runtime's
Space or owner.

The human issuer may send `{"kind":"cloud"}` to
`POST /v1/runtime_enrollments`; missing kind defaults to `local`. The enrollment
selects the server-side Runtime kind. Harness metadata registration does not
rewrite it, so a cloud Runtime remains cloud after login/reconnect. Re-enrollment
requires a grant with matching kind.

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
Restart the daemon to refresh installed metadata. Executable availability is
not proof of provider authentication or successful execution.

Worker registration rejects string lists, and readiness only accepts a matching
`provider_type` with `available: true`. Channel context capabilities remain
unchanged. Local paths are descriptive, potentially sensitive metadata and are
never commands for the Worker to execute.
