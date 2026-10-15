# Network Fleet: KVM + Secure MCP Tunnel

This document describes the isolated deployment shape for the self-hosted Network Fleet prototype.

## Migration state

Two independent control planes coexist:

- **Local remote MCP** is the primary/default transport. ChatGPT Desktop uses the local stdio plugin; remote surfaces use the Fleet Gateway path once Secure MCP Tunnel is provisioned.
- **Official remote MCP** remains installed and connected as the automatic same-project/same-D0 fallback for eligible Local runtime/startup/transport/capability failures. Authorization/security denials never trigger fallback.

Do not disable or remove the official remote MCP as part of normal Local deployment.

## Current construction-tool boundary

Keep these capabilities distinct during development:

- Remote Desktop Commander 0.2.52 is the current **official remote MCP construction channel**. Its exposed tool surface is device/file/terminal/process/search/config/control-plane operations; do not describe that 31-tool surface as local GUI or browser control.
- Direct control of the user's local Edge/iKuai pages requires a separate **Computer Use / local GUI browser-control capability**. If that capability is not mounted in the current ChatGPT project/session, do not work around it by extracting browser cookies, passwords, or private session state and do not substitute an unrelated cloud browser connector.
- A missing GUI tool mount does not authorize changing the bound device or project. `network.ikuai` remains exact-host bound to YUAN.

The iKuai KVM must therefore be created through the normal authenticated web UI once the local GUI capability is available. The production router does not expose SSH for this workflow.

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
|   -> 127.0.0.1:24787/mcp      |
|                              |
| Fleet Gateway                |
|   MCP:   127.0.0.1:24787      |
|   Agent: 127.0.0.1:24788      |
|   Admin: 127.0.0.1:24789      |
|                              |
| Caddy / LAN TLS ingress      |
|   :24443 /agent -> :24788      |
|   :24443 /admin -> :24789      |
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

The optional Web Admin is also loopback-only behind Caddy. It is a LAN diagnostics/onboarding surface only: device status, project routing, redacted recent-call metadata and bootstrap guidance. It intentionally exposes no filesystem, shell, process or MCP execution endpoint, so losing the Web UI cannot weaken `.control` enforcement.

## Trust boundaries

1. The KVM Gateway performs exact-host routing and verifies the pinned Ed25519 device fingerprint.
2. Every Agent call is authorized again by the local `.control` policy before execution.
3. The Gateway does not provide a Windows file path for the probe tool. The Agent derives the probe file from the authorized `physical_root`.
4. `network.ikuai` stays bound to `YUAN`. No automatic YUAN-to-HEMA fallback is allowed.
5. A healthy duplicate Agent for the same hostname is an ambiguity error, not a takeover.
6. Generation fencing, call timeout/cancel, audit logging, and policy-revision checks remain mandatory.

## MCP authentication

For the private Tunnel prototype, use bearer authentication:

- `tunnel-client` reaches `http://127.0.0.1:24787/mcp` inside the KVM.
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
  --mcp-server-url http://127.0.0.1:24787/mcp

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

Managed Windows devices should use the canonical L1 bootstrap instead of cloning this project manually:

```powershell
pwsh -NoProfile -File <CONTROL_ROOT>\tools\Register-LocalRemoteMcpDevice.ps1 -Json
```

The first pass installs/updates the shared Local Remote MCP runtime and plugin, provisions the CA and Agent identity/config, and returns the canonical hostname, Ed25519 public-key fingerprint and current policy revision. After that identity is approved in the Gateway, rerun with `-InstallTask -StartNow` to register the PowerShell 7 SYSTEM startup task.

The permanent Agent uses the exact host-specific identity and `.control` authorization. A Local or Official transport failure never permits routing to a different D0 device.

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

Official Remote MCP remains installed as fallback after Local becomes primary. Disabling or removing it is a separate future action requiring explicit user approval.
