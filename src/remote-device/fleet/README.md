# Remote Fleet PoC

Status: isolated proof of concept. This directory is not wired into the production `desktop-commander remote` command.

## Goal

Replace the hosted Remote control plane without replacing Desktop Commander's local MCP executor.

The stable public routing identity is the machine hostname (`YUAN` / `HEMA`) plus a pinned device public-key fingerprint. Runtime session IDs, websocket IDs, account IDs, hosted `link_id` values and hosted `device_id` values are never durable routing identities.

## Source audit

### Keep

- `desktop-commander-integration.ts`: local stdio MCP client, execution probe, child-process supervision, lazy restart/backoff, tool proxy and clean shutdown.
- The useful call-lifecycle ideas in `device.ts`: bounded duplicate-call suppression, explicit tool completion/failure handling and local executor health coupling.
- Upstream remote tests and `test/helpers/remote-stand-in.js` as compatibility/oracle material.

### Replace for self-host mode

- `device-authenticator.ts`: browser/device-code OAuth tied to the hosted account model.
- `remote-channel.ts`: Supabase Auth/PostgREST/Realtime/presence transport and its hosted database row state machine.
- Hosted `mcp_devices` / `mcp_remote_calls` persistence as routing identity.
- Supabase-specific offline update script and hosted diagnostics assumptions.

These files can remain for the existing hosted mode; the self-host transport should be parallel, not a destructive rewrite.

### Add

- Gateway challenge-response using a per-machine asymmetric key.
- Pinned `hostname -> public-key fingerprint` device registry.
- Explicit `project_id -> hostname` routing policy.
- Gateway and local `.control` authorization checks.
- A single outbound WSS connection from each Windows agent to the VPS gateway.
- Stable error codes and audit records.
- Windows service supervision and a pinned Desktop Commander version before production use.

## Fail-closed invariants

- `TARGET_OFFLINE(YUAN)` never routes to HEMA.
- `TARGET_OFFLINE(HEMA)` never routes to YUAN.
- A key/hostname mismatch returns `IDENTITY_MISMATCH`.
- More than one active session for a hostname returns `TARGET_AMBIGUOUS` until fencing/cleanup resolves it.
- A project targeting the wrong host returns `PROJECT_DEVICE_DENIED`.
- Gateway/agent policy revision disagreement returns `POLICY_SKEW`.
- The agent must perform its own local project authorization before executing a tool call.

## Current PoC

`identity.ts` implements hostname canonicalization, public-key fingerprinting and challenge signature verification.

`router.ts` implements exact-host routing with the fail-closed invariants above.

`test/test-fleet-router.js` tests pure routing and identity behavior.

`test/test-fleet-ws-poc.js` runs a loopback-only WebSocket gateway on `127.0.0.1` with two simulated agents. It exercises challenge-response, exact-host dispatch, disconnect cleanup, duplicate sessions, policy skew and the local authorization gate. It never opens a public listener. It also routes a read-only get_config call through the real DesktopCommanderIntegration and a transient local Desktop Commander MCP child.

## Next implementation seam

The next step is to turn the loopback agent behavior into a production-quality `FleetChannel` beside the existing `RemoteChannel`, then feed accepted calls into `DesktopCommanderIntegration.callClientTool()` after the local `.control` policy gate. The gateway side should expose one stable Streamable HTTP MCP endpoint and translate an explicit `{ project_id, hostname, tool, args }` request into the exact authenticated WSS agent session.

Do not deploy this PoC to the VPS until the gateway authentication, request timeout/cancellation, fencing token, audit log, restart recovery and Windows service behavior are implemented and tested.
