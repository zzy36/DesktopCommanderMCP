---
name: local-remote-mcp-default
description: Use Local Remote MCP first for authorized machine, filesystem, search and terminal work. Trigger when the user says MCP, remote MCP, local MCP, remote machine, Desktop Commander, or asks to operate an authorized computer. Fall back to Official Remote MCP only for same-target Local availability, transport, or capability failures; never for authorization/security denials.
---

Treat these as separate control paths:

- **Local Remote MCP** is the primary/default MCP path.
- **Official Remote MCP** is the hosted Remote Desktop Commander path kept enabled as fallback.
- **Computer Use / GUI automation** is separate from both MCP transports.

For an unqualified MCP/remote-control request, first resolve the exact active L3 `project_id` and its fixed D0 target from `.control`. Do not choose a transport before the project/device route is known.

Use the `local_remote_mcp` server first. Every Local tool call must include the exact active L3 `project_id`. Never invent, substitute, or rebind a project or device.

Automatic fallback to Official Remote MCP is allowed only when Local cannot serve the already-authorized same target because the Local plugin/runtime is unavailable, its transport/startup fails, or the required capability is not exposed locally. The fallback must keep the same `project_id` and same D0 hostname/device. Official account/link selection is only an R0 transport choice after D0 is fixed.

Do **not** fall back on policy/security/identity errors such as `PROJECT_DEVICE_DENIED`, `POLICY_SKEW`, `IDENTITY_MISMATCH`, `TARGET_AMBIGUOUS`, path-scope denial, or an approval denial. Those are hard boundaries and must be surfaced instead of bypassed.

Local Remote MCP re-authorizes every call through the machine's `.control` policy. Filesystem/search paths are restricted to the authorized `physical_root`; terminal sessions start in that root. Follow the active project's AGENTS/CURRENT/HANDOFF and Git state for project facts.

Prefer Local Remote MCP for file inspection/editing, searches, terminal commands and project-scoped process sessions. Use Computer Use only when the task specifically requires GUI/browser/mouse/keyboard interaction.

On web/mobile/iPad, prefer the self-hosted Secure MCP Tunnel path when available. If that Local path is unavailable, the same fallback rule applies: Official Remote MCP may be used automatically only for the same fixed D0/project and only for Local availability/transport/capability failure, never to evade a Local authorization denial.
