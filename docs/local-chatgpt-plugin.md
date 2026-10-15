# Local Control MCP ChatGPT Desktop plugin

This package makes the self-hosted Local Control MCP the primary machine-control path on a computer running ChatGPT Desktop, without disabling the hosted Official Remote MCP.

## Control-plane precedence

1. `Local Control MCP` is the default for requests that say `MCP`, `remote MCP`, `远程 MCP`, Desktop Commander, or project-scoped machine control without naming a provider.
2. `Official Remote MCP` stays installed and connected, but is used only when the user explicitly requests the official/hosted path or explicitly approves fallback after Local Control MCP is unavailable.
3. `Computer Use / GUI automation` remains a separate capability.

There is no silent Local-to-Official fallback.

## Desktop fast path

The plugin contains a local stdio MCP server declaration. The launcher derives the machine's `.control` root from the existing NetworkFleet Agent configuration and loads `dist/remote-device/fleet/local-plugin-main.js` from the `network.local-control-mcp` implementation checkout.

The local proxy dynamically reads the Desktop Commander OSS tool schemas, exposes a controlled subset, and adds a required `project_id` to every tool. Every call is re-authorized against local `.control` for the current hostname.

Filesystem and search paths are constrained to the authorized project's `physical_root`. Local process sessions start in that root. Follow-up process/search operations are accepted only for sessions created by the same `project_id` in the current Local Control MCP server process.

The intentionally excluded tools are global configuration/history/system surfaces that could weaken isolation or disclose unrelated project activity.

## Remote web/mobile path

ChatGPT web/mobile cannot directly execute a local stdio MCP app. Keep the existing `fleet-mcp` KVM + Secure MCP Tunnel deployment for that transport. The local desktop plugin and the KVM/Tunnel path share the same `.control` authorization model; the hosted Official Remote MCP is not required for either path once Tunnel provisioning is complete.

## Personal installation on Windows

The canonical package template is under `deploy/chatgpt-local-plugin/local-control-mcp`.

For a personal local marketplace, copy it to `~/.codex/plugins/local-control-mcp`, expose it from `~/.agents/plugins/marketplace.json`, and install it with:

```powershell
codex plugin add local-control-mcp@local-network-fleet --json
```

The expected installed state is `installed=true`, `enabled=true`, with `INSTALLED_BY_DEFAULT`. Restart ChatGPT Desktop after first installation or package updates so the GUI reloads local marketplace plugins.
