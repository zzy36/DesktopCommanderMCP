---
name: local-remote-mcp-default
description: Use the self-hosted Local Remote MCP for machine, filesystem, search, terminal, and remote-control work. Trigger when the user says MCP, remote MCP, local MCP, remote machine, Desktop Commander, or asks to operate an authorized computer, unless they explicitly request Official Remote MCP.
---

Treat these names as distinct control planes:

- **Local Remote MCP** is the primary/default MCP path.
- **Official Remote MCP** is the hosted Remote Desktop Commander path kept installed as a fallback.
- **Computer Use / GUI automation** is separate from both MCP transports.

When the user says "MCP", "remote MCP", "远程 MCP", or otherwise asks for MCP-based computer control without naming a provider, use the `local_remote_mcp` server from this plugin. Do not silently call the Official Remote MCP.

Use Official Remote MCP only when the user explicitly says "Official Remote MCP", "官方远程 MCP", or explicitly approves falling back to it after Local Remote MCP is unavailable. Keeping Official Remote MCP installed does not make it the default.

Every Local Remote MCP tool call must include the exact active L3 `project_id`. Do not invent, substitute, or auto-fallback to a different project or device. A `PROJECT_DEVICE_DENIED` result is a hard boundary, not a reason to retry another project or host.

Local Remote MCP re-authorizes every call through the machine's `.control` policy. Filesystem and search paths are restricted to the authorized `physical_root`; terminal sessions start in that root. Follow the active project's AGENTS/CURRENT/HANDOFF and Git state for project facts.

Prefer Local Remote MCP for file inspection/editing, searches, terminal commands, and project-scoped process sessions. Use Computer Use only when the task specifically requires GUI/browser/mouse/keyboard interaction.

If this desktop-only plugin is unavailable on the current surface, say that the Local Remote MCP desktop path is unavailable here. Do not silently consume Official Remote MCP as a substitute. The KVM + Secure MCP Tunnel path is the intended remote/web/mobile transport once its OpenAI account-side Tunnel connection is provisioned.
