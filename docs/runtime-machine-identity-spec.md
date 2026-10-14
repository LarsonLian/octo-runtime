# Runtime and Machine Identity

Date: 2026-10-14. See the normative [local/online contract](runtime-local-and-online-contract.md).

## Local Identity

The daemon SDK creates or reads a stable `runtime_id` during local profile initialization. It is not assigned as a consequence of successful cloud enrollment. The same app-owned Home, subject and tenant profile retains its ID across restarts, module shutdown, failed registration and reconnect.

The Home stores one `machine_id` in `machine.json`. This is an untrusted installation grouping label, not a hardware fingerprint, authorization key or universal device identity. Multiple Runtime profiles can share it; different app Homes are not automatically merged.

Runtime ID, business Agent ID, Provider session ID and Runtime credential have different meanings. Local Runtime existence does not prove IPC readiness, Provider availability or remote authorization.

## Optional Registration

worker-access registers the existing local Runtime ID. Its identity and protected credential files remain separate. Before registration, a local Runtime need not have a credential ID or cloud owner record.

Registration must validate the caller, tenant, owner and real object scope. A locally supplied Runtime ID is not authorization. See [owner/provider contract](runtime-owner-provider-contract.md).

Normal credential reset and renewed SDK enrollment preserve the local Runtime ID. Chat session reset does not reset Runtime identity. Explicit destruction of local identity is a separate operation and must not be an automatic connectivity repair.

The standalone CLI retains its existing enrollment-centered bootstrap and is not the customer SDK startup contract. Final CLI and online-toggle migration is tracked separately.

## Storage And Recovery

Keep profile identity and Runtime credential files separate from the Home-level machine label. Human Tokens and enrollment grants do not become local model context; protected Runtime credentials are only needed for enabled cloud access.

Source event windows are bounded memory, not a durable outbox. Business applications own history and Provider session storage appropriate to their execution path. Reconnect or registration failure never justifies silently changing Runtime identity.
