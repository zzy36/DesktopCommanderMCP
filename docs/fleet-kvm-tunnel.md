# Network Fleet: KVM + Secure MCP Tunnel

This document describes the isolated deployment shape for the self-hosted Network Fleet prototype.

## Migration state

Two independent control planes must coexist until explicit cutover approval:

- **Official remote MCP**: the currently installed Remote Desktop Commander service. It remains enabled and unchanged while Network Fleet is tested.
- **Local remote MCP**: this self-hosted Fleet Gateway + Fleet Agent path. It is test-only until the acceptance matrix is complete.

Do not disable, replace, reconfigure, or route around the official remote MCP as part of the prototype deployment.

## Target topology

```text
ChatGPT custom MCP
        |
        | OpenAI Secure MCP Tunnel (outbound HTTPS 443)
        v
+------------------------------+
| fleet-mcp Linux KVM          |
|                              |
| tunnel-client                |
|   -> 127.0.0.1:8787/mcp      |
|                              |
| Fleet Gateway                |
|   MCP:   127.0.0.1:8787      |
|   Agent: 127.0.0.1:8788      |
|                              |
| Caddy / LAN TLS ingress      |
|   :9443 -> 127.0.0.1:8788    |
+---------------+--------------+
                |
                | WSS on trusted LAN only
          +-----+-----+
          |           |
        YUAN        HEMA
      FleetAgent   FleetAgent
          |           |
       .control     .control
          |           |
   Desktop Commander OSS executor
```

The MCP and Agent ingress are deliberately separate listeners. The MCP listener stays loopback-only. The Agent listener is not exposed directly; a local reverse proxy provides WSS on the LAN side.

## Trust boundaries

1. The KVM Gateway performs exact-host routing and verifies the pinned Ed25519 device fingerprint.
2. Every Agent call is authorized again by the local `.control` policy before execution.
3. The Gateway does not provide a Windows file path for the probe tool. The Agent derives the probe file from the authorized `physical_root`.
4. `network.ikuai` stays bound to `YUAN`. No automatic YUAN-to-HEMA fallback is allowed.
5. A healthy duplicate Agent for the same hostname is an ambiguity error, not a takeover.
6. Generation fencing, call timeout/cancel, audit logging, and policy-revision checks remain mandatory.

## MCP authentication

For the private Tunnel prototype, use bearer authentication:

- `tunnel-client` reaches `http://127.0.0.1:8787/mcp` inside the KVM.
- The bearer token is supplied through an environment variable such as `FLEET_MCP_BEARER_TOKEN`.
- The token is not stored in Git or in the JSON config.

OAuth remains supported by the service layer for later deployments. Do not use the self-hosted OAuth login page as a zero-public-ingress workaround: Secure MCP Tunnel carries MCP discovery and requests, but the browser-facing authorization server is a separate reachability problem.

## Secure MCP Tunnel

Use the current OpenAI `tunnel-client` release rather than pinning a download URL in this repository.

First-use flow:

```bash
export CONTROL_PLANE_API_KEY='...'

tunnel-client init \
  --sample sample_mcp_with_dcr \
  --profile network-fleet \
  --tunnel-id tunnel_... \
  --mcp-server-url http://127.0.0.1:8787/mcp

tunnel-client doctor --profile network-fleet --explain
tunnel-client run --profile network-fleet
```

Keep the runtime API key out of checked-in files. The tunnel client requires outbound HTTPS to OpenAI; no inbound Internet listener is required for the private MCP.

## Gateway configuration

See `deploy/fleet-kvm/gateway.example.json`.

Important deployment values are intentionally placeholders:

- the real YUAN device fingerprint;
- the current `.control` policy revision;
- the final LAN hostname/certificate used by the WSS reverse proxy.

Do not fill them from stale chat history. Read them from the live Agent provisioning output and current `.control` Git HEAD during deployment.

## Agent provisioning

On each Windows host, build first and print the durable identity before registering it at the Gateway:

```powershell
node dist/remote-device/fleet/agent-main.js --config C:\ProgramData\NetworkFleet\agent.json --print-provisioning
```

The output provides the canonical hostname, Ed25519 public-key fingerprint, current policy revision, discovered `.control` root, and state directory.

The permanent Agent service must use the exact host-specific config. Do not route `network.ikuai` to HEMA when YUAN is offline.

## Acceptance gate before cutover

The local remote MCP is not a replacement until all of these pass:

- ChatGPT discovery through Secure MCP Tunnel;
- exact `network.ikuai -> YUAN` routing;
- `fleet_status`, `list_devices`, `read_test_file`, and `write_test_file` through the full chain;
- HEMA rejected for `network.ikuai`;
- path injection rejected;
- stale `.control` revision rejected;
- duplicate YUAN Agent rejected as ambiguous;
- Gateway restart and generation fencing;
- YUAN reboot and Agent auto-start;
- KVM reboot and Gateway/tunnel auto-start;
- network interruption and clean reconnect;
- timeout/cancel behavior;
- audit log confirms arguments, file contents, secrets, and result bodies are not copied into logs;
- dependency/security review and version pinning completed.

Only after explicit user approval should the official remote MCP be disabled.
