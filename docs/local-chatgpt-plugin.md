# Local Control MCP 安装与连接

Local Control MCP 将自托管设备控制作为默认通道。桌面插件、远程 MCP 和个人云端 App 属于同一个产品；官方 Remote Desktop Commander 保留为故障备用。

## 桌面安装

受管 Windows 设备先按本机 `.control` 注册路由，再运行已有入口：

```powershell
pwsh -NoProfile -File "<CONTROL_ROOT>\tools\Register-LocalControlMcpDevice.ps1" -Json -InstallTask -StartNow
```

已登记设备沿用原身份，不重新配对。安装模板位于 `deploy/chatgpt-local-plugin/local-control-mcp`，市场标识为 `local-control`，插件标识为 `local-control-mcp@local-control`，MCP server name 为 `local_control_mcp`。技术标识保持不变。

检查插件列表中的 **Local Control MCP** 蓝色 LM 图标，并核对实际进程/工具握手版本，不能仅检查磁盘文件。应用可能自动刷新缓存，不要预先重启；只有确证需要重启时才请求授权。YUAN 的 ChatGPT/Codex 当前禁止自动关闭或重启。

## 远程连接

新设备使用 `lcm remote`，在本地浏览器核对设备名、短码和指纹后批准。设备登记不授予项目权限，权限仍来自设备的 `.control`。

普通 ChatGPT 使用已有个人 App 连接受管 HTTPS `/mcp`，OAuth 页面给出短码，本地控制中心核对后允许。不得在公网开放所有者/设备管理或批准接口。文案、图标和工具元数据更新复用已有 App 和授权，不新建 App、不撤销 grant。

## 使用与边界

调用必须带真实 `project_id`；远程还必须带准确 `hostname`，不能自动切换 YUAN/HEMA。文件和搜索限于授权项目根；终端从项目根启动。后续调用只能操作本项目当前运行时拥有的进程/搜索句柄。

远程操作依赖登录用户的 Git 凭据、浏览器或用户环境时使用 `execution_context: interactive`；用户桥接缺失时报告缺口，不切换 SYSTEM。后台任务可用 `system`。

只有同项目、同设备确认发生 `LOCAL_RUNTIME_UNAVAILABLE`、`LOCAL_STARTUP_FAILURE` 或 `LOCAL_TRANSPORT_FAILURE`，才按 L1 策略使用 hosted RDC。能力缺口和安全拒绝不允许自动回退。下一次新的用户级操作先探测 Local，恢复后立即返回 Local。不重复提交结果未明的副作用操作。

本地提供 20 个项目工具，远程提供相同 20 个项目工具及 6 个设备/调用状态工具。全局配置修改、托管计费/额度、多租户管理和独立 GUI 工具不属于当前目录；GUI 使用已有授权用户态适配器。详见产品仓库 `docs/CAPABILITY-PARITY.md`。
