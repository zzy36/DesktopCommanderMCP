# LCM / RDC next-chat handoff — 2026-10-17

## 2026-10-18 continuation closeout
- Accepted starting point was branch `feat/rdc-supervisor-0.3.6`, HEAD `3ca58ecbaa90d24918855641298ff97089e9b79a`; frozen 0.3.5 acceptance was not repeated.
- Added focused RDC packaging/status-parser coverage and exported the two pure Gateway helpers only for direct regression testing. Implementation/test commit: `3f0bbcc11b0b195bca698e5ab164b7bdff01b6e1`, pushed to `origin/feat/rdc-supervisor-0.3.6`.
- Build PASS; `test/test-rdc-supervisor.js`, `test/test-fleet-admin-web.js`, and `test/test-fleet-presentation-zh.js` PASS.
- Live Gateway/Admin was already at `64176962e86afa8b4d06bdf0b38b4ce495b7559e` when this continuation started. It has now been atomically advanced to `3f0bbcc11b0b195bca698e5ab164b7bdff01b6e1` using the canonical transactional control-center deploy path. Post-cutover health PASS: Gateway/Caddy/FRPC active, Owner present, GPT binding active, all three devices online.
- Windows Agent runtime was intentionally not upgraded: YUAN / HEMA / YUANS remain frozen at `680e0e90b0a44a7c5a6aa08c2ded5314eb992d17` (`device-v1`).
- RDC supervisor tasks already existed on all three machines before this continuation. Current common state: `DesktopCommanderRemote-<hostname>` Running, enabled, `MSFT_TaskLogonTrigger`, restart count 999, restart interval PT1M, StartWhenAvailable=true, MultipleInstances=IgnoreNew, RDC pinned to 0.3.0, hidden window mode.
- YUANS canary executed the full action chain over LCM: status -> show -> hide -> disable -> enable -> stop -> start -> restart -> hide. Every action PASS; stop reached Ready/processCount=0; final state restored to Running + hidden + autostart=true.
- Live LAN Admin POST was then verified end-to-end on exact YUANS (`/admin/api/devices/rdc`, action=status): PASS, Running, autostart=true, hidden, RDC 0.3.0. HEMA and YUAN exact-host `Control-RDC status` also PASS without restarting either machine.
- Hosted RDC was used minimally after LCM acceptance: one account device-list and one exact YUANS ping. All three hosted devices were Online at RDC 0.3.0 and the YUANS ping succeeded. No `Resource not found` occurred in this continuation.
- Hosted RDC account telemetry reported only 11% remote calls remaining. Treat RDC hosted quota as a real near-term pressure point; normal-path work should remain on LCM.
- ChatGPT itself permits the same user account on multiple devices, while model/account usage limits are plan/model/activity dependent. No controlled three-PC simultaneous model-request test was forced because there was no current model-limit error to classify and doing so would consume usage. Therefore a ChatGPT account/model concurrency limit remains possible but is not demonstrated by this continuation.
- Root `G:\Projects\local-control-mcp` had pre-existing unrelated dirty registration/icon work. It was deliberately not staged, modified, or committed by this continuation.

## Conversation scope
- The continuation chat is inside the Network L2 ChatGPT Project and is explicitly bound for this task to L3 `network.local-control-mcp`.
- Exact-host routing remains fail-closed. No unrelated L3 or HEMA Commerce content was touched.

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

## Post-acceptance state / remaining decision
1. Requested RDC three-machine supervisor rollout and Gateway/Admin controls are accepted; do not repeat the YUANS action-chain canary unless a reproducible regression appears.
2. Gateway/Admin is live at implementation commit `3f0bbcc...`; Windows Agents intentionally remain on the frozen `680e0e90...` runtime. The supervisor does not require an Agent 0.3.6 rollout to function.
3. The remaining release-management decision is whether/when to merge `feat/rdc-supervisor-0.3.6` into the implementation release branch and label a broader 0.3.6 release. That is separate from the now-working live Gateway/Admin + RDC supervisor path.
4. Preserve exact-host and HEMA Commerce-only boundaries. Normal remote operations should prefer LCM while hosted RDC quota is low.

## Fresh-chat rate-limit / connector investigation
User suspects three PCs + LCM/RDC may be contributing to ChatGPT throttling. Do not assume causality. Separate these layers:
- ChatGPT account/model request and concurrency limits shared across three PCs;
- RDC hosted quota / connector limits;
- LCM self-hosted transport (no RDC hosted quota), while LCM tool calls still occur inside ChatGPT turns;
- background LCM device heartbeats/Admin polling do not by themselves equal ChatGPT model requests;
- the prior long chat intermittently returned RDC connector `Resource not found` while the user could see YUAN RDC online. Treat that historical symptom as connector/session-runtime, not proof the device was offline.

Continuation result:
1. LCM exact-host operations were repeatedly successful across YUAN / HEMA / YUANS, including the full YUANS supervisor canary and Gateway Admin dispatch. No self-hosted transport throttle was observed.
2. Hosted RDC cold discovery + exact YUANS ping succeeded. No `Resource not found` occurred in this continuation.
3. RDC `who_am_i` reported `remote_calls_left_pct=11`; hosted RDC quota is therefore low enough to be a concrete risk and should not be consumed for normal-path work.
4. A simultaneous second/third-PC ChatGPT model-request stress test was not forced. If an actual ChatGPT throttle recurs, capture exact UI/error text, timestamp, selected model, machine, and connector before any retry; compare it to the model reset/allowance message rather than attributing it to LCM.
5. Continue to avoid broad RDC discovery/retries.

## Do not redo
- Do not redo 31-tool parity audit.
- Do not redo icon work.
- Do not re-enroll devices unless a real enrollment error appears.
- Do not alter Gateway/OAuth/device trust without evidence.
- Do not touch unrelated YUAN projects or HEMA Commerce files.
## Temporary live freeze - 2026-10-18
- User accepted the current LCM/RDC state as a temporary freeze. Treat live Gateway/Admin implementation `3f0bbcc11b0b195bca698e5ab164b7bdff01b6e1` as the repair baseline; do not advance it without a reproducible issue or an explicit release decision.
- Annotated Git tag: `rdc-supervisor-0.3.6-live-freeze-20261018` -> `3f0bbcc11b0b195bca698e5ab164b7bdff01b6e1`.
- Windows Agents remain intentionally frozen at `680e0e90b0a44a7c5a6aa08c2ded5314eb992d17`; RDC remains pinned to 0.3.0 with three-machine autostart/restart supervision accepted.
- Current ChatGPT desktop Sentry windows on YUAN / HEMA / YUANS contain no HTTP 409 or 429. Observed client-side transport evidence instead includes repeated 10-second Statsig network timeouts on YUAN around 2026-10-17 22:37-22:39 +08:00 and `chatgpt_pubsub_transport_closed` on YUAN/HEMA around 2026-10-18 00:36-00:37 +08:00. This does not prove account/model concurrency throttling.
- If the symptom recurs, capture exact UI/error text and timestamp before retrying; search the local Sentry breadcrumbs first for HTTP 429/409 and transport-close/timeout evidence. Keep LCM as default; RDC hosted remains fallback and had only 11% remote calls remaining at acceptance.
- Post-freeze transient observation: one LCM `get_more_search_results` call returned connector-level `Connection failed` for `https://xjp.cctvwow.top/mcp`. Same-D0 RDC fallback immediately verified public OAuth metadata HTTP 200 plus `network-fleet-gateway`, `network-fleet-caddy`, and `lcm-frpc` all active at `3f0bbcc...`; the next LCM exact-YUAN probe succeeded. Classify this single event as a transient ChatGPT-to-LCM MCP connection failure unless it becomes reproducible; no code/runtime change was justified.
- The only literal `429` found in YUANS persisted Sentry data was fractional timestamp `1792255210.429` immediately before `chatgpt_pubsub_transport_closed`; it was not an HTTP status. Targeted persistent searches found no actual HTTP 409/429, `rate limit`, `too many requests`, or concurrent-request error on the three machines.
