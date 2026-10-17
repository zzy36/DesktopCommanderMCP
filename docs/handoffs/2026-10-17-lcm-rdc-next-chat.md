# LCM / RDC next-chat handoff — 2026-10-17

## Conversation scope
- This ChatGPT conversation is an ordinary chat, not visibly bound to a ChatGPT Project container.
- Operational work is nevertheless scoped to L3 `network.local-control-mcp` and is persisted in Git.

## Canonical Git state
- Repo: `G:\Projects\local-control-mcp\local-only\mcp\DesktopCommanderMCP`
- Worktree: `G:\Projects\local-control-mcp\local-only\worktrees\rdc-supervisor-0.3.6`
- Branch: `feat/rdc-supervisor-0.3.6`
- Current HEAD before this handoff commit: `283e1c20fc13e962b8314f441cf084bfa9b4a67e`
- Feature commits:
  - `6417696` Add RDC supervisor controls for LCM 0.3.6
  - `283e1c2` Clarify RDC autostart status control
- Build PASS.
- `test/test-fleet-admin-web.js` PASS.
- `test/test-fleet-presentation-zh.js` PASS.

## Frozen production baseline
- Live LCM runtime remains `680e0e90b0a44a7c5a6aa08c2ded5314eb992d17` on YUAN / HEMA / YUANS.
- Production product baseline remains LCM 0.3.5 until 0.3.6 is explicitly deployed.
- Do not overwrite the current 0.3.5 runtime while developing/testing 0.3.6.
- Three machines are online through LCM at handoff.

## Machine prerequisites now unified
- YUAN / HEMA / YUANS system PowerShell: 7.6.7 at `C:\Program Files\PowerShell\7\pwsh.exe`.
- WinGet: v1.29.380 on all three.
- App Installer: 1.29.380.0 on all three.
- YUAN Codex-private PowerShell 7.6.5 is separate and must not be overwritten.

## RDC current behavior and 0.3.6 goal
- User currently starts RDC manually on all three machines with a visible PowerShell running `npx @wonderwhy-er/desktop-commander@latest remote`.
- Actual RDC version observed on all three: 0.3.0.
- 0.3.6 implementation pins RDC 0.3.0 instead of `@latest` to prevent silent drift.
- New Windows scripts in branch:
  - `deploy/windows/Install-RDCAutostart.ps1`
  - `deploy/windows/Control-RDC.ps1`
- Gateway/Admin additions provide per-device RDC:
  - status
  - start
  - stop
  - restart
  - show
  - hide
  - autostart enable/disable
- Intended model: logon task + restart policy; display/hide changes task window mode and may briefly restart RDC. No new public port/API on the device.
- Existing LCM User Bridge show/hide controls remain separate.

## What remains before deployment
1. Review current feature diff for correctness and remove any obsolete duplicate implementation remnants if found.
2. Add/adjust tests specifically covering RDC control API/status parsing and Windows packaging contract.
3. Canary on YUANS first; verify:
   - RDC auto-starts without manual PowerShell launch;
   - start/stop/restart/show/hide/enable/disable from LCM Admin work;
   - LCM runtime remains 0.3.5 during canary unless explicitly staging 0.3.6;
   - RDC device remains the same account/device and no re-login is forced.
4. Then deploy to HEMA and YUAN, preserving exact-host and HEMA Commerce-only role.
5. Only after acceptance decide whether to merge/release 0.3.6.

## Fresh-chat rate-limit / connector investigation
User suspects three PCs + LCM/RDC may be contributing to ChatGPT throttling. Do not assume causality. Separate these layers:
- ChatGPT account/model request and concurrency limits shared across three PCs;
- RDC hosted quota / connector limits;
- LCM self-hosted transport (no RDC hosted quota), while LCM tool calls still occur inside ChatGPT turns;
- background LCM device heartbeats/Admin polling do not by themselves equal ChatGPT model requests;
- current long chat intermittently returned RDC connector `Resource not found` while the user could see YUAN RDC online. Treat this as a connector/session-runtime symptom, not proof the device was offline.

Fresh-chat test should be minimal:
1. Cold-start LCM exact-host ping/start_process on one device.
2. Cold-start RDC exact device on the same device.
3. Then one controlled simultaneous test from a second/third PC only if needed.
4. Record exact UI/error text, timestamp, model, machine, connector, and whether it is model-rate-limit, connector-runtime, or RDC quota.
5. Avoid broad discovery and repeated retries; user wants low quota usage.

## Do not redo
- Do not redo 31-tool parity audit.
- Do not redo icon work.
- Do not re-enroll devices unless a real enrollment error appears.
- Do not alter Gateway/OAuth/device trust without evidence.
- Do not touch unrelated YUAN projects or HEMA Commerce files.