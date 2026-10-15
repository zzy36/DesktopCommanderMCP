// LCM-owned presentation only. Protocol names, schemas, codes and authorization stay stable.
const tools: Record<string, [string, string]> = {
  get_config: ['查看项目配置', '查看当前授权项目的配置摘要；不提供任意全局配置修改。'],
  read_file: ['读取文件', '读取授权项目内文件，支持文本、PDF、图片、表格和 DOCX。offset 从 0 开始，负数读取末尾；length 限制行数。使用绝对路径；URL 模式禁用，路径不得越出项目根。'],
  read_multiple_files: ['批量读取文件', '读取授权项目内多个文件；每项附带路径，单个文件失败不会中止其他读取。'],
  write_file: ['写入文件', '在授权项目内写入文件。mode 为 rewrite 时覆盖，为 append 时追加；修改前核对已有内容。'],
  write_pdf: ['生成 PDF', '在授权项目内根据内容生成或更新 PDF 文件；先核对目标路径和已有内容。'],
  edit_block: ['替换文件内容', '在授权项目文件中精确替换 old_string 为 new_string；expected_replacements 指定预期匹配次数。先读取原文，避免覆盖无关修改。'],
  create_directory: ['创建目录', '在授权项目内创建目录；路径不得越出项目根。'],
  list_directory: ['查看目录', '列出授权项目内目录内容；depth 控制递归深度。'],
  move_file: ['移动或重命名文件', '在授权项目内移动或重命名文件或目录；源路径和目标路径均需通过项目授权。'],
  get_file_info: ['查看文件信息', '查看授权项目内文件或目录的大小、类型和时间等信息。'],
  start_search: ['开始搜索', '在授权项目内搜索文件名或内容。返回搜索 sessionId，后续通过 get_more_search_results 读取；无需结果时使用 stop_search。'],
  get_more_search_results: ['读取更多搜索结果', '读取本项目当前运行时创建的搜索 sessionId 的更多结果；offset、length 控制分页。'],
  stop_search: ['停止搜索', '停止本项目当前运行时拥有的搜索 sessionId；不得操作其他项目的搜索。'],
  list_searches: ['查看搜索任务', '列出本项目当前运行时拥有的搜索任务。'],
  start_process: ['运行命令', '在授权项目根目录启动 PowerShell 7 命令或交互进程。返回 PID；运行中使用 read_process_output 读取，使用 interact_with_process 输入。需要登录用户的 Git 凭据、浏览器或用户环境时，远程调用必须选择 execution_context: interactive；不可降级到 SYSTEM 或 RDC。长任务只启动一次，保留 PID 后轮询。'],
  read_process_output: ['读取进程输出', '读取本项目拥有的 PID 输出。offset 为 0 时读取新增输出，负数读取末尾；timeout_ms 限制等待时间。进程仍运行时继续轮询，不重复启动原命令。'],
  interact_with_process: ['向进程输入', '向本项目拥有的 PID 发送 input，并读取新输出；适用于终端和交互解释器。后续调用保持原 execution_context。'],
  force_terminate: ['强制结束终端任务', '强制结束本项目当前运行时拥有的终端 PID；先核对目标，保留需要的输出。'],
  list_sessions: ['查看终端任务', '列出本项目当前运行时拥有的终端任务、PID、运行时间和等待输入状态。'],
  kill_process: ['结束进程', '结束本项目当前运行时拥有的 PID；不得用来关闭无关应用或其他项目进程。'],
  // Reserved for upstream catalog variants; not added to the exposed contract.
  list_processes: ['查看进程', '查看授权范围内进程。'],
  fleet_status: ['查看设备状态', '查看指定 project_id 和 hostname 的授权、在线和策略状态；不会改路由到另一台设备。'],
  list_devices: ['查看可用设备', '列出指定 project_id 已授权的设备；不泄露私钥或托管账号标识。'],
  ping: ['检查设备连接', '检查指定 project_id 和 hostname 的设备当前是否在线。'],
  who_am_i: ['查看服务身份', '查看 Local Control MCP 自托管服务身份；不模拟 RDC 的托管账号或额度。'],
  get_tool_result: ['读取远程调用结果', '读取 call_id 对应的远程结果；必须属于指定 project_id 和 hostname。运行中的调用只轮询，不重复提交。'],
  list_remote_tool_calls: ['查看最近远程调用', '列出指定 project_id 的最近调用，可进一步限定 hostname；limit 为 1 到 50。'],
};

export function localizeLcmTool(tool: any): any {
  const copy = structuredClone(tool);
  const entry = tools[copy.name];
  if (!entry) throw new Error(`Missing LCM presentation: ${copy.name}`);
  copy.title = entry[0];
  copy.description = `Local Control MCP：${entry[1]}`;
  copy.annotations = { ...copy.annotations, title: entry[0] };
  const descriptions: Record<string, string> = {
    project_id: '当前真实 L3 project_id；授权失败时不得替换或跨项目重绑。',
    hostname: '准确的 D0 hostname；不允许跨设备自动回退。',
    execution_context: 'system 用于后台任务；interactive 用于登录用户的 Git 凭据、浏览器或用户环境，要求本设备已有授权用户会话，不降级到 SYSTEM。',
  };
  for (const [key, property] of Object.entries(copy.inputSchema?.properties ?? {})) {
    if (descriptions[key]) (property as any).description = descriptions[key];
  }
  return copy;
}

export function localizeLcmError(error: unknown): string {
  const code = (error as any)?.code;
  const labels: Record<string, string> = {
    PROJECT_DEVICE_DENIED: '项目、设备、路径或任务归属未获授权；请核对真实 project_id 和目标设备，禁止跨项目回退。',
    POLICY_SKEW: '设备策略版本不一致，请同步受管策略后重试。',
    IDENTITY_MISMATCH: '设备身份校验失败，请从本地管理中心核对登记身份。',
    TARGET_AMBIGUOUS: '目标设备不唯一，请明确指定 hostname。',
    INSUFFICIENT_SCOPE: '当前 OAuth 授权范围不足，请核对该操作需要的权限。',
    LOCAL_RUNTIME_UNAVAILABLE: '本地运行时不可用。',
    LOCAL_STARTUP_FAILURE: '本地运行时启动失败。',
    LOCAL_TRANSPORT_FAILURE: '本地传输连接失败。',
    INTERACTIVE_SESSION_UNAVAILABLE: '当前设备没有可用的已登录用户执行会话；请恢复用户桥接，不会改用 SYSTEM。',
  };
  const detail = error instanceof Error ? error.message : String(error);
  const messages: Record<string, string> = {
    'local administrator sign-in required': '请先登录本地管理中心。',
    'CSRF validation failed': '表单校验失败，请刷新本地页面后重试。',
    'too many sign-in requests': '登录请求过多，请稍后重试。',
    'sign-in form expired': '登录表单已过期，请刷新后重试。',
    'sign-in rate limit': '登录尝试过于频繁，请稍后重试。',
    'invalid local credential': '本地管理密钥不正确。',
    'administrator session limit': '管理员会话数量已达上限，请稍后重试。',
    'untrusted management Origin': '管理请求来源不受信任，请使用配置的本地管理地址。',
    'authorization request expired or invalid': '授权请求已过期或无效，请从原连接页面重新发起。',
    'verification code does not match authorization request': '验证码与当前授权请求不一致，请核对原页面短码。',
    'binding changed; review and explicitly approve replacement': '当前绑定已变化，请重新核对并明确批准替换。',
    'request body too large': '请求内容过大。',
    'JSON object required': '请求内容必须是 JSON 对象。',
  };
  return messages[detail] ?? (labels[code] ? `${labels[code]}（${detail}）` : detail);
}
