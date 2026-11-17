---
name: local-control-mcp-default
description: 已明确的设备操作缺少可覆盖目标的宿主原生能力时使用。按准确设备调用 LCM，技术故障时遵同设备 RDC 回退规则。
---

# Local Control MCP 设备传输

当前宿主先用可覆盖本次目标和操作的原生能力。原生缺少所需能力或不能到达准确目标时，可使用已授权 LCM。选定 LCM 后，已知准确已登记 hostname 直接调用目标工具，需要发现设备时使用 list_devices。

登录用户的 Git、浏览器和 GUI 使用 interactive。后台操作按授权显式选 system，interactive 不可用时保持原上下文。跟进异步工作使用原 call_id 或 PID，并保留实际错误码。没收到结果或调用超时的状态是未知，离线以设备连接状态为准。

同设备实际 LCM 技术故障可按授权使用 RDC。身份不符、拒绝或未知写入不得通过回退重放。项目规则和授权按既有调用方与目标策略处理。
