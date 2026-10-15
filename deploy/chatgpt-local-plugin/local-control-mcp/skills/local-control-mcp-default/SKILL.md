---
name: local-control-mcp-default
description: 优先使用 Local Control MCP 执行已授权的设备、文件、搜索和终端操作。适用于 MCP、远程 MCP、本地 MCP、远程电脑和 Desktop Commander 请求；只有同项目、同设备的本地运行时、启动或传输确认故障，才可回退到官方 Remote MCP。能力缺口和授权拒绝不得自动回退。
---

# Local Control MCP

Local Control MCP 是默认主通道。官方 Remote MCP 是保留的托管 Remote Desktop Commander 备用通道。Computer Use / GUI 自动化是独立能力。

处理未指明路由的 MCP 或远程控制请求时，先通过 `.control` 确定真实 L3 `project_id` 和固定 D0 设备，再选择传输；不得发明、替换或重绑项目或设备。

优先使用 `local_control_mcp` server，每次调用都必须带准确的 `project_id`。Local Control MCP 会通过目标设备的 `.control` 重新授权；文件和搜索路径限于授权的 `physical_root`，终端从该根目录启动。项目事实以当前 AGENTS/CURRENT/HANDOFF 和 Git 为准。

仅当已授权的同项目、同 D0 发生确认的本地运行时不可用、启动失败或传输故障时，才按 L1 策略使用官方备用通道。官方 account/link 只是在固定 D0 后选择的 R0 传输，不改变设备或项目身份。

回退不粘滞：每次新的用户级操作先轻量探测同 L3/D0 的 Local；恢复后立即返回 Local，再执行实际操作。不自动重放已提交、结果不明确的副作用操作。

能力缺口必须明确报告，不得自动回退。`PROJECT_DEVICE_DENIED`、`POLICY_SKEW`、`IDENTITY_MISMATCH`、`TARGET_AMBIGUOUS`、路径拒绝、批准拒绝等安全边界也不允许回退或绕过。

文件、搜索、终端和项目进程操作优先通过 Local Control MCP。只有任务明确需要浏览器、鼠标或键盘时才使用 Computer Use；不得把 GUI 作为授权拒绝的绕过路径。

网页、手机和 iPad 优先使用已有的自托管 Secure MCP Tunnel。仅在其确认发生同项目、同 D0 的运行时、启动或传输故障时，按相同规则使用官方备用通道。

远程操作需要已登录用户的 Git 凭据、浏览器/GUI 或用户环境时，使用 `execution_context: interactive`，并要求准确 D0 上有授权的用户桥接。用户会话缺失不允许改用 SYSTEM 或 RDC。进程/搜索后续调用继承原执行上下文，不得更换；后台任务可用 `system`。
