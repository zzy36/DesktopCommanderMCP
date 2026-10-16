// LCM-owned presentation only. Protocol names, schemas, codes and authorization stay stable.
const tools: Record<string, [string, string]> = {
  "get_config": [
    "查看设备配置",
    "读取准确设备的本地执行器配置。"
  ],
  "set_config_value": [
    "修改设备配置",
    "修改本地执行器配置项；由目标设备外部治理判断权限。"
  ],
  "read_file": [
    "读取文件",
    "按绝对路径读取目标设备文件。"
  ],
  "read_multiple_files": [
    "批量读取文件",
    "读取目标设备多个文件。"
  ],
  "write_file": [
    "写入文件",
    "写入或追加目标文件；先核对内容与目标设备。"
  ],
  "write_pdf": [
    "生成 PDF",
    "在目标设备生成或更新 PDF。"
  ],
  "create_directory": [
    "创建目录",
    "在目标设备创建目录。"
  ],
  "list_directory": [
    "查看目录",
    "列出目标设备目录内容。"
  ],
  "move_file": [
    "移动文件",
    "移动或重命名目标设备文件；先核对源与目标。"
  ],
  "get_file_info": [
    "查看文件信息",
    "读取目标设备文件或目录属性。"
  ],
  "edit_block": [
    "替换文件内容",
    "在目标文件精确替换指定内容。"
  ],
  "start_search": [
    "开始搜索",
    "搜索目标设备文件名或内容，返回 sessionId。"
  ],
  "get_more_search_results": [
    "读取更多搜索结果",
    "按 sessionId 分页读取本设备搜索结果。"
  ],
  "stop_search": [
    "停止搜索",
    "停止目标设备指定搜索任务。"
  ],
  "list_searches": [
    "查看搜索任务",
    "列出目标设备当前执行器的搜索任务。"
  ],
  "start_process": [
    "运行命令",
    "在准确设备执行命令，默认登录用户。后台操作可显式选择 system；不自动降级。长任务只启动一次，保留 PID 后轮询。"
  ],
  "read_process_output": [
    "读取进程输出",
    "读取目标设备指定 PID 的输出；保持原执行上下文。"
  ],
  "interact_with_process": [
    "向进程输入",
    "向指定 PID 输入并读取新输出；保持原执行上下文。"
  ],
  "force_terminate": [
    "结束终端任务",
    "停止指定终端任务；先确认 PID。"
  ],
  "list_sessions": [
    "查看终端任务",
    "列出目标设备当前执行器终端任务。"
  ],
  "kill_process": [
    "结束进程",
    "结束准确设备的指定 PID；操作前核对授权和进程用途。"
  ],
  "list_processes": [
    "查看运行进程",
    "列出准确设备进程、PID、CPU 和内存。"
  ],
  "shutdown": [
    "停止 LCM Agent",
    "仅停止远程 LCM Agent，不关闭 Windows。重新启动 Agent 任务可恢复。"
  ],
  "fleet_status": [
    "查看设备状态",
    "查看准确已登记设备在线状态、版本及最近连接。"
  ],
  "list_devices": [
    "查看所有设备",
    "列出此 Owner 的全部已登记设备；不要求项目身份。"
  ],
  "ping": [
    "检查设备连接",
    "与准确已登记 Agent 实际往返，返回延迟与运行状态。"
  ],
  "who_am_i": [
    "查看服务身份",
    "查看私人自托管 Local Control MCP 服务身份。"
  ],
  "get_tool_result": [
    "读取远程调用结果",
    "按 call_id 读取 Owner 范围内的调用状态或结果。不要重复提交结果不明确的写操作。"
  ],
  "list_remote_tool_calls": [
    "查看最近远程调用",
    "读取 Owner 范围内最近调用，可按准确设备过滤。"
  ],
  "get_recent_tool_calls": [
    "查看本机调用历史",
    "读取目标设备本地执行器调用历史。"
  ],
  "get_usage_stats": [
    "查看运行统计",
    "读取本地 Gateway 调用、结果、延迟、超时、字节和运行统计，不涉及托管额度。"
  ]
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
