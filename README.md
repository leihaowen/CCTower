# CCTower(Claude Code Tower)

像航空塔台一样调度多个 Claude Code 会话:每个 agent 在自己的 worktree"跑道"上并行干活,塔台(Attention Inbox)只在需要决策、权限或出现意外时召唤你。

> A web control tower for parallel Claude Code sessions: isolated git-worktree "runways" per agent, an attention inbox that only calls you when a decision, permission, or failure needs a human.

> [!WARNING]
> **CCTower 按设计就能在运行它的机器上执行任意命令**——它创建终端会话、运行你给的命令、
> 并可以用 `bypassPermissions` 启动 agent。请把它当作「你自己的 shell 的网页入口」来对待:
>
> - 默认只监听 `127.0.0.1`,本机自用无需额外配置。
> - **一旦配置成对外可达**(`CCW_HOST` 非回环,或设了 `CCW_ALLOWED_HOSTS`),必须设 `CCW_TOKEN`,
>   否则服务会拒绝启动。别把它直接暴露在公网上。
> - 不要让 CCTower 里的 agent 去处理你不信任的代码库:agent 持有的回调令牌目前是全权令牌
>   (见 [SECURITY.md](SECURITY.md) 的「已知限制」)。
>
> 仅支持 Linux / macOS(依赖 node-pty 与 tmux);Windows 需在 WSL 内运行。

## 运行

```bash
npm install
npm start          # http://127.0.0.1:7080
```

依赖:Node.js ≥ 20、git、已登录的 [Claude Code](https://claude.com/claude-code) CLI;建议安装 tmux(见下)。

> 📖 第一次使用?看 **[docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)**——完整依赖、快速上手、配置与安全须知、常见问题。
>
> 🚀 想让它常驻、崩了自动拉起、开机自启?看 **[deploy/README.md](deploy/README.md)**(systemd 部署,附 unit 模板)。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `CCW_PORT` | `7080` | 监听端口 |
| `CCW_HOST` | `127.0.0.1` | 监听地址;非回环地址**必须**同时配 `CCW_TOKEN`,否则拒绝启动 |
| `CCW_TOKEN` | 空 | 访问令牌,设置后 API/WS 均需携带(网页会提示输入);对外部署时必填,建议 ≥16 位随机串 |
| `CCW_ALLOWED_HOSTS` | 空 | 额外允许的 `host:port`(反向代理域名),逗号分隔;**非空时同样强制要求 `CCW_TOKEN`** |
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

- 默认只绑定 localhost;API/WS 校验 Host 与 Origin(防浏览器发起的 CSRF / DNS rebinding)
- **对外可达时强制令牌**:`CCW_HOST` 非回环或配了 `CCW_ALLOWED_HOSTS` 而没设 `CCW_TOKEN` 时,
  服务拒绝启动(Host 头是请求方可控的,挡不住 `curl`——令牌是对外部署唯一的认证边界)
- `CCW_TOKEN` 常数时间比较;hooks/MCP 回调自动携带,经 WebSocket 子协议传输,不进 URL/日志
- 摘要模型输入最小化(近期事件 + 屏幕尾部);摘要文本永不自动执行
- 终端逐键输入不落盘(可能含密码),仅显式的决策/权限操作记录在案

**数据会离开本机的两处**,都需要你显式开启或知情:AI 归纳会把近期事件与终端画面尾部
(约 1500 字符)发给 Claude,并消耗你自己的额度;飞书通知会把任务目标与状态行发到你配置的
webhook(默认关闭)。

完整信任模型、已知限制与漏洞报告方式见 **[SECURITY.md](SECURITY.md)**。

## 桌面客户端(实验性)

不想开浏览器盯着网页?`desktop/` 下有一个 Tauri 2 桌面壳:托盘常驻,通过 SSH 隧道连接你已经在
跑的 CCTower 服务端(Mac/Linux 桌面 → Linux 服务器),服务器休眠/服务端重启/断网重连都自动处理,
需要决策时弹系统通知。桌面壳本身不跑服务端,只是"隧道 + 状态感知的壳",服务端部署方式不变。

前置要求、配置方式与手动验收清单见 **[desktop/README.md](desktop/README.md)**。

## 远程访问(多机聚合)

有多台机器都跑着 CCTower,或者有些机器在 NAT 后面没有公网 IP?`gateway/` 提供一个远程访问网关:
把它们聚合到一个 HTTPS 域名下,agent 主动出站接入,手机浏览器也能直接用,各机 CCTower 全程只听回环。

完整架构、部署步骤与排障见 **[docs/GATEWAY.md](docs/GATEWAY.md)**。

## 测试

```bash
npm test    # node:test,152 个用例(状态机 / resume / MCP 协议 / gitReview / 暴露面校验 / 网关与 agent)
```

## License

MIT — 见 [LICENSE](LICENSE)。

## 声明

CCTower 是一个独立的社区项目,**与 Anthropic 没有关联,未获其背书或审核**。
"Claude"、"Claude Code" 是 Anthropic 的商标,此处仅用于说明本项目与之配合使用。
本项目通过官方 Claude Code CLI 的公开接口(`--settings` hooks、`--mcp-config`、
`--append-system-prompt`)工作,不修改也不重分发 Claude Code 本体;使用时请遵守
Anthropic 的服务条款与使用政策。运行 CCTower 产生的模型调用消耗你自己的账号额度。
