---
name: local-control-mcp-default
description: 用于明确 MCP 或远程设备操作。Codex 本机默认原生工具；远程 LCM 优先，同 D0 RDC 故障修复备用，恢复后回切。
---

# Local Control MCP

Codex 当前宿主的文件、搜索、终端、编辑、构建、测试、浏览器和技能默认使用原生能力。本技能只选择远程传输，不接管本机工具。普通 ChatGPT 需要机器控制时优先 LCM。

LCM 是 Owner 范围的设备传输。list_devices 不需要项目参数，执行选择准确已登记 hostname；公共工具不使用 project_id、scope_kind 或 machine_approval。项目/root/writer/lease 判断由调用界面和目标机外部治理负责，必要上下文通过 MCP _meta 传递，不借业务项目维护机器。事实以目标 AGENTS/CURRENT/HANDOFF 与 Git 为准。

LCM 无托管额度成本，默认优先；RDC 有额度成本，是保留的备用通道。发现 LCM runtime/startup/transport、UI/管理入口、Computer Use 或 Cloud/private discovery 阻塞时，直接使用同作用域、同 D0 RDC 诊断、修复、部署、验证 LCM，不重复请示、不增加重试门槛。单个 UI gate 不阻断其他独立工作。

回退不粘滞：后续普通操作轻量探测其实际所需的 LCM 能力，健康即回切。Agent 在线不等于当前所需能力或 Cloud schema 已恢复。不重放结果不明确的写操作。保留 RDC，不卸载或禁用。

不得伪造 URL、身份或跨错设备/项目；授权拒绝本身不授予新权限。修复自有 LCM 仍遵守正常写入/lease/备份边界；破坏数据、新的未授权跨界写入、重建 OAuth/身份、不可逆删除才暂停确认。安全检查失败可以换合法工具/入口，不能绕过检查。

远程用户 Git 凭据、GUI、浏览器和用户环境使用准确 D0 的 execution_context: interactive；不复制凭据到 SYSTEM，不把用户会话缺失悄悄降级到 SYSTEM。后台工作可用 system，进程后续调用保持原执行上下文。网页/手机/iPad 优先已有自托管 Secure MCP。

ChatGPT 只保留一个私人 LCM App。Agent/runtime/用户执行器是内部组件；设备先独立登记到 Owner，之后再由外部治理分配项目角色。
