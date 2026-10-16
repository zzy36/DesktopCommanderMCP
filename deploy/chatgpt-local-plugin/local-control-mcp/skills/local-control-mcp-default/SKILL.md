---
name: local-control-mcp-default
description: 用于用户明确指定的 MCP、Local Control MCP、远程电脑或 Desktop Commander 操作；远程传输优先 LCM。Codex 当前宿主上的文件、搜索、终端、编辑、构建、测试、浏览器和技能默认使用原生能力。能力缺口和授权拒绝不得自动回退。
---

# Local Control MCP

Local Control MCP 是远程设备和明确 MCP 操作的默认主通道。Codex 当前宿主上的工作默认使用原生工具和技能；本技能不限制或接管原生能力。官方 Remote MCP 是保留的备用通道，仍须遵守当前用户的禁用要求。Computer Use / GUI 自动化是独立能力。

处理未指明路由的 MCP 或远程控制请求时，先通过 `.control` 确定真实 L3 `project_id` 和固定 D0 设备，再选择传输；不得发明、替换或重绑项目或设备。

优先使用 `local_control_mcp` server，每次调用都必须带准确的 `project_id`。Local Control MCP 会通过目标设备的 `.control` 重新授权；文件和搜索路径限于授权的 `physical_root`，终端从该根目录启动。项目事实以当前 AGENTS/CURRENT/HANDOFF 和 Git 为准。

仅当已授权的同项目、同 D0 发生确认的本地运行时不可用、启动失败或传输故障时，才按 L1 策略使用官方备用通道。官方 account/link 只是在固定 D0 后选择的 R0 传输，不改变设备或项目身份。

回退不粘滞：每次新的用户级操作先轻量探测同 L3/D0 的 Local；恢复后立即返回 Local，再执行实际操作。不自动重放已提交、结果不明确的副作用操作。

能力缺口必须明确报告，不得自动回退。`PROJECT_DEVICE_DENIED`、`POLICY_SKEW`、`IDENTITY_MISMATCH`、`TARGET_AMBIGUOUS`、路径拒绝、批准拒绝等安全边界也不允许回退或绕过。

远程设备上的文件、搜索、终端和项目进程操作优先通过 Local Control MCP；本机 Codex 工作使用原生能力。浏览器、鼠标或键盘任务使用对应原生工具或 Computer Use；不得把 GUI 作为授权拒绝的绕过路径。

网页、手机和 iPad 优先使用已有的自托管 Secure MCP Tunnel。仅在其确认发生同项目、同 D0 的运行时、启动或传输故障时，按相同规则使用官方备用通道。

远程操作需要已登录用户的 Git 凭据、浏览器/GUI 或用户环境时，使用 `execution_context: interactive`，并要求准确 D0 上有授权的用户桥接。用户会话缺失不允许改用 SYSTEM 或 RDC。进程/搜索后续调用继承原执行上下文，不得更换；后台任务可用 `system`。
