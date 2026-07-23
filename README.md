# CCTower(Claude Code Tower)

像航空塔台一样调度多个 Claude Code 会话:每个 agent 在自己的 worktree"跑道"上并行干活,塔台(Attention Inbox)只在需要决策、权限或出现意外时召唤你。

> A web control tower for parallel Claude Code sessions: isolated git-worktree "runways" per agent, an attention inbox that only calls you when a decision, permission, or failure needs a human.

## 运行

```bash
npm install
npm start          # http://127.0.0.1:7080
```

依赖:Node.js ≥ 20、git、已登录的 [Claude Code](https://claude.com/claude-code) CLI;建议安装 tmux(见下)。

> 📖 第一次使用?看 **[docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)**——完整依赖、快速上手、配置与安全须知、常见问题。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `CCW_PORT` | `7080` | 监听端口 |
| `CCW_HOST` | `127.0.0.1` | 监听地址;对外部署必须同时配 `CCW_TOKEN` |
| `CCW_TOKEN` | 空 | 访问令牌,设置后 API/WS 均需携带(网页会提示输入) |
| `CCW_ALLOWED_HOSTS` | 空 | 额外允许的 `host:port`(反向代理域名),逗号分隔 |
| `CCW_DATA_DIR` | `./.ccw-data` | 会话数据、worktree、hooks 配置目录 |
| `CCW_BACKEND` | `auto` | `auto` 优先 tmux 托管;`pty` 强制直接 PTY |

其他偏好(飞书推送等)在网页"通知设置"中配置,存 `<数据目录>/config.json`。

## 能力一览

**会话即工作单元**
- 创建 Terminal / Claude Code session;Claude 会话默认独立 git worktree + 分支,互不污染
- tmux 托管(专用 socket):**CCTower 服务重启/升级不影响任何运行中的会话**,重启后自动重新接管
- Claude 会话记录内部 session id,进程重启用 `--resume` 恢复原对话上下文;id 失效自动兜底开新对话
- 会话自动命名:跟随 Claude 的 OSC 终端标题上报(手动命名优先)

**网页终端**
- xterm.js:输入/复制粘贴(选中即复制)/resize/滚动回放;断线 2 秒自动重连,标签页休眠恢复即重连
- 多标签只有一个输入控制者,其余只读可接管;心跳清除僵尸连接,控制权自动移交

**状态采集(不解析屏幕文字)**
1. 确定性信号:进程/退出码 + Claude Code 官方 hooks(Notification / Stop / UserPromptSubmit …)
2. Agent 上报:内置本地 MCP 工具 `report_status`(预授权,不弹权限),curl 仅兜底
3. AI 归纳:headless `claude -p` 按需生成结构化 Brief,永不覆盖新鲜的 Agent 上报

**Attention Inbox**
- 需要权限 > 需要决策 > 阻塞 > 完成待审,四组置顶;其余后台推进
- 每张卡片是一个迷你终端:真实屏幕缩影(ANSI 彩色、TUI 边框已清洗)+ 状态灯
  (绿色跑马灯=运行,黄闪=需要你,蓝=就绪,红=意外,绿常亮=待审)
- 决策选项卡片上直接点;权限请求卡片上直接批准/拒绝;答案写回原会话并记入决策时间线
- 通知:页面 toast + 桌面通知 + **飞书群机器人推送**(同一原因去重,回应后解除)

**Diff 审阅与一键合并**
- worktree 全部改动(含未提交/未跟踪)网页审阅;squash 合并回项目分支
- `git merge-tree` 无副作用冲突预检,主分支分毫不动;冲突可一键交回 Claude 解决后重试
- 合并成功后一键收尾:停止进程、清理 worktree 与分支、归档(记录保留)

## 架构

```text
Browser (xterm.js, 无构建)
   ↕ WebSocket(events / term)+ REST
CCTower server (Node.js)
 ├── SessionManager:tmux/PTY 托管、headless xterm 屏幕状态、状态机
 ├── Claude 集成:hooks --settings、MCP --mcp-config、--append-system-prompt 协议
 ├── Brief:Agent 上报 > AI 归纳(claude -p) > 系统观测
 ├── gitReview:diff / merge-tree 预检 / squash 合并
 └── 存储:.ccw-data(sessions.json / config.json / worktrees / hooks)
   ↕
tmux -L ccw(会话跑在这里,服务死了它们还活着)
```

## 安全

- 默认只绑定 localhost;API/WS 校验 Host 与 Origin(防 CSRF / DNS rebinding)
- 可选 `CCW_TOKEN` 认证,常数时间比较;hooks/MCP 回调自动携带
- 摘要模型输入最小化(近期事件 + 屏幕尾部);摘要文本永不自动执行
- 终端逐键输入不落盘(可能含密码),仅显式的决策/权限操作记录在案

## 测试

```bash
npm test    # node:test,16 个用例(状态机 / resume / MCP 协议 / gitReview)
```

## License

MIT
