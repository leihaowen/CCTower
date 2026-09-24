# Hook 审批与 Inbox 作答 — 设计

日期:2026-09-24 · 状态:已确认,实施中

## 背景

现状:网页批准/拒绝权限靠向 TUI 写按键(`'1'` / Esc,`server/manager.js` permissionAction),
依赖 TUI 布局;AskUserQuestion 只能进终端回答;`needs_permission` 要等约 6 秒后的 Notification hook 才触发。

目标:用官方 `PermissionRequest` hook 接管这三件事,官方 CLI 兼容,不改 Claude Code。

## 实测事实(claude 2.1.281,tmux 真实会话)

1. AskUserQuestion 同样触发 PermissionRequest(`tool_name: "AskUserQuestion"`)。
2. hook 运行期间 TUI 对话框**同时**显示,二者竞速:
   - hook 先返回决定 → 对话框自动关闭,transcript 记 "Allowed by PermissionRequest hook"。
   - TUI 先作答 → hook 不被杀,继续跑到结束,输出被忽略。
3. 因此网页与终端两条路并存,无需"超时回落";服务端需自行识别"已在终端处理"。

官方协议要点(code.claude.com/docs/en/hooks):
- 输入:`tool_name`、`tool_input`、`permission_suggestions`、`permission_mode`、`session_id`;**无 `tool_use_id`**。
- 输出:`{hookSpecificOutput:{hookEventName:"PermissionRequest", decision:{behavior, updatedInput?, updatedPermissions?, message?, interrupt?}}}`。
- `type:"http"` hook:2xx 空 body = 无决定(走正常权限流程);连接失败/非 2xx = 非阻塞错误;超时默认 600s。
- AskUserQuestion / ExitPlanMode 需 `allow` + `updatedInput`(回显原输入;AskUserQuestion 加 `answers`,多选以逗号连接)。

## 设计

### hook 配置(server/claudeSetup.js)
- `PermissionRequest`:matcher `*`,`type:"http"`,url `/api/hook/:id/PermissionRequest`,
  headers 带 `X-CCW-Token`(有令牌时),timeout 600。
- `PostToolUse`:沿用 curl 回调,`async: true`,用于识别终端已处理。

### permissionBroker(server/permissionBroker.js,新)
按会话维护挂起请求 `{id, sessionId, kind, toolName, input, suggestions, summary, createdAt}`,持有 HTTP 响应。
- `kind`:AskUserQuestion → `question`;ExitPlanMode → `plan`;其余 → `permission`。
- `open(sessionId, payload, res)`:登记请求,590s 定时器到期回空响应;响应连接关闭时清理。
- `resolve(requestId, {behavior, answers, message, always})`:构造官方决定 JSON 回写并移除。
  - `permission`+allow:`{behavior:"allow"}`;`always` 时附 `updatedPermissions` = suggestions 中
    `addRules` 项,`destination` 强制改为 `session`(不写入 worktree 配置文件)。
  - `question`+allow:`updatedInput = {...input, answers}`;`answers` 为 `{问题文本: 答案}`。
  - `plan`+allow:`updatedInput = input`。
  - deny:`{behavior:"deny", message}`,不 interrupt(让模型看到理由自行调整)。
- `release(sessionId, match?)`:回空响应并移除——已在别处处理。`match={toolName,input}` 时
  优先匹配同工具同参数,否则匹配该会话唯一的同名工具请求。
- 纯内存,不落盘:服务重启后 hook 连接断开 = 无决定,TUI 对话框仍有效。

### manager 接入
- 收到 PermissionRequest:`question` → `needs_decision`,其余 → `needs_permission`,状态行用摘要。
- 释放时机:`PostToolUse`(按工具+参数匹配)、`Stop` / `UserPromptSubmit` / `SessionEnd` / 进程退出(全部释放)。
  释放后记决策时间线"在终端中处理"。
- 会话序列化结果附 `pendingRequests`(不含内部字段),供前端渲染。
- 新 action `resolve-request`:`{requestId, behavior, answers?, message?, always?}`;记决策时间线,状态回 executing。
- 旧 `approve-permission` / `deny-permission`:该会话有挂起的 permission 请求时转为 resolve,否则保留按键兜底。

### 前端(public/app.js,Inbox 卡片 + 会话决策框)
- permission:工具名 + 参数摘要(Bash 命令 / 文件路径 / 其他 JSON 截断);批准 / 本会话总是允许 / 拒绝(可填理由)。
- question:逐题渲染选项(单选/多选)+"其他"输入框,提交。
- plan:计划正文(纯文本)+ 批准 / 驳回并附意见。
- 多个请求按时间顺序全部列出。

## 测试
- 单测(node:test):决定 JSON 形状(allow/always/deny/question/plan);answers 多选拼接;
  PostToolUse 匹配释放、Stop 全部释放;超时回空;连接关闭清理;claudeSetup 生成两个新 hook。
- 端到端:tmux 真实 claude,网页作答 AskUserQuestion 与批准 Bash 各一次。

## 不做
飞书交互审批(IM 期)、自动审批规则、挂起请求持久化。
