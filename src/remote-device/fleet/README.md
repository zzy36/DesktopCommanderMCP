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

`test/test-fleet-ws-poc.js` runs a loopback-only WebSocket gateway on `127.0.0.1` with two simulated agents. It exercises challenge-response, exact-host dispatch, disconnect cleanup, duplicate sessions, policy skew and the local authorization gate. It never opens a public listener. It also routes a read-only `get_config` call through the real `DesktopCommanderIntegration` and a transient local Desktop Commander MCP child.

`plugin-server.ts` adds a real stateless Streamable HTTP MCP surface using the Node HTTP server and the existing MCP SDK. The initial Plus/Personal-Plugin acceptance surface is deliberately small: `fleet_status`, `list_devices`, `read_test_file`, and `write_test_file`. The write probe cannot choose an arbitrary path; the backend owns the dedicated test path.

`test/test-fleet-plugin-http.js` proves the complete local write path:

`Streamable HTTP MCP -> Fleet exact-host router -> authenticated loopback WSS session -> YUAN agent -> DesktopCommanderIntegration -> Desktop Commander write_file/read_file`.

The test writes only under a dedicated OS temporary directory, confirms the bytes on disk, reads the value back through Desktop Commander, and verifies that requesting HEMA for `network.ikuai` fails closed without changing the test file.

The HTTP write proof is still local only. It does not imply that a public ChatGPT Plus Personal Plugin has been accepted until the same write tool succeeds through an authenticated HTTPS endpoint from ChatGPT itself.

## Next implementation seam

Turn the loopback agent behavior into a production-quality `FleetChannel` beside the existing `RemoteChannel`, then feed accepted calls into `DesktopCommanderIntegration.callClientTool()` after the local `.control` policy gate. Replace the test-only backend behind `plugin-server.ts` with the real gateway dispatcher while preserving the stable MCP tool schema.

Before any VPS or Windows service deployment, implement and test gateway authentication, request timeout/cancellation, bounded pending calls, heartbeat/liveness, reconnect jitter, fencing/session generation, audit records, restart recovery and persistent device keys.

Only after those controls pass locally should an authenticated HTTPS `/mcp` endpoint be exposed for the Plus Personal Plugin write acceptance test. The official Remote plugin remains enabled until the self-host path passes feature-parity and reliability acceptance.

## Agent hardening now proven locally

`fleet-channel.ts` is the production-oriented outbound agent transport. It adds challenge-response authentication, application heartbeat/liveness, exponential reconnect with jitter, bounded in-flight calls, cooperative cancellation/timeouts, duplicate-call result replay, and a monotonically increasing gateway `generation` fence. A call carrying a stale generation returns `FENCED_SESSION`; a duplicate call ID replays the cached result instead of executing twice.

`control-policy.ts` intentionally does not reimplement `.control` policy rules. It keeps a long-lived Python bridge to the existing `machine_control_gateway.py` and calls its `_authorize_project()` for each authorization request, so project/device/partition/override/physical-root decisions continue to come from the current authoritative registries. The bridge also resolves the `.control` Git HEAD as the advertised policy revision. If that revision changes, an authenticated Fleet session is considered stale and must re-handshake.

`device-identity.ts` persists a per-machine Ed25519 identity. Stable routing identity is therefore canonical hostname plus pinned public-key fingerprint; official account IDs, link IDs, hosted device IDs and websocket session IDs remain ephemeral and are never trusted as durable identity.

`fleet-agent.ts` composes the persistent device identity, real `.control` authorization, `FleetChannel`, a required fail-closed per-tool policy, and `DesktopCommanderIntegration`. The agent cannot be constructed without a tool policy. The included `createDedicatedTestFilePolicy()` permits only `read_file` / `write_file` to one exact probe file and rejects all other tools and paths.

`test/test-fleet-agent.js` proves a service-like lifecycle end to end: the agent authenticates to a loopback gateway, writes and reads through the real Desktop Commander child, rejects path escape and cross-project/cross-host requests, stops, starts as a fresh Agent instance, retains the same device fingerprint, receives a new fencing generation, and continues to execute authorized reads.

The current safety boundary is deliberate: Desktop Commander remains the internal executor, but the public Plugin surface must not expose the raw 25-tool local API until each capability class has a local policy (filesystem roots, terminal commands, process control, config mutation, document operations, and other destructive actions). Feature parity is accepted only after those policies and reliability tests pass; parity does not mean bypassing authorization.
