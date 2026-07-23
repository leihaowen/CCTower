# CCTower 上手指南

从零把 CCTower(Claude Code Tower)在自己机器上跑起来,并用它调度多个 Claude Code 会话。

---

## 1. 它是什么

一个网页化的"航空塔台":每个 Claude Code / 终端会话在自己的 git worktree"跑道"上并行干活,你不用逐个盯终端——塔台只在**需要决策、需要授权、出现阻塞或完成待审**时把对应会话顶到 Attention Inbox 并通知你。

核心心智:**把多条长终端记录压缩成一组可行动的工作摘要。**

---

## 2. 环境依赖

### 必需

| 依赖 | 版本要求 | 说明 | 检查命令 |
|---|---|---|---|
| **Node.js** | ≥ 20(建议 20/22/24) | 运行服务与前端资源 | `node -v` |
| **npm** | 随 Node 附带 | 安装依赖 | `npm -v` |
| **git** | ≥ 2.30 | worktree 隔离、diff 审阅、一键合并 | `git --version` |
| **Claude Code CLI** | 最新版,**已登录** | 被托管的 agent 本体 | `claude --version` |

> Claude Code 未安装或未登录:见 https://claude.com/claude-code 。CCTower **复用你本机已登录的 CLI**,不另外要 API Key。

### 强烈建议

| 依赖 | 作用 | 不装的后果 |
|---|---|---|
| **tmux**(≥ 3.0) | 托管会话进程 | 缺失时自动降级为直接 PTY:**CCTower 服务一重启,所有会话进程就没了**。装了 tmux,服务升级/重启不影响运行中的会话。 |

检查:`tmux -V`。安装:macOS `brew install tmux`;Debian/Ubuntu `sudo apt install tmux`。

### 平台

Linux / macOS。Windows 建议用 WSL2(`node-pty` 与 tmux 在原生 Windows 上体验不佳)。

---

## 3. 快速开始(3 步)

```bash
git clone git@github.com:leihaowen/CCTower.git
cd CCTower
npm install          # 安装依赖(见下方清单)
npm start            # 启动,默认 http://127.0.0.1:7080
```

浏览器打开 **http://127.0.0.1:7080**,点右下角"**＋ 新建 Session**"即可。

### npm install 装了什么

运行期依赖(全部会自动装好,无需手动):

| 包 | 用途 |
|---|---|
| `express` | HTTP 服务与 REST API |
| `ws` | WebSocket(事件流 + 终端流) |
| `node-pty` | 伪终端;**含原生模块,首次安装会本地编译** |
| `@xterm/xterm` `@xterm/addon-fit` | 网页终端(前端,本地托管,无 CDN) |
| `@xterm/headless` | 服务端还原屏幕(迷你终端、AI 摘要素材) |

> `node-pty` 编译需要 C++ 工具链:macOS 装 Xcode Command Line Tools(`xcode-select --install`);Debian/Ubuntu 装 `build-essential python3`。绝大多数机器上 `npm install` 会直接过。

---

## 4. 第一次使用:跑通一个 Claude 会话

1. 点"**＋ 新建 Session**",类型选 **Claude Code**。
2. **项目目录**:点"浏览…"逐级点选,或直接输入路径(git 仓库会带 `git` 徽标)。
3. **初始任务**:用自然语言写要它做什么,比如"修复登录接口的重复提交 bug,遇到方案选择时停下来问我"。
4. (可选)展开的**模型 / 权限模式 / 附加参数**——下方有实时命令预览,不改就是默认。
5. 保持"独立 Git worktree 隔离"勾选(推荐),点**创建**。

然后:
- 会话会在 `.ccw-data/worktrees/<id>` 的独立分支上干活,**不污染你的工作目录**。
- 回到 **Attention Inbox**:每张卡片是一个迷你终端(真实彩色画面)+ 状态灯。
  - 🟢 绿色跑马灯 = 运行中 · 🟡 黄灯闪 = 需要你决策/授权 · 🔵 蓝灯 = 就绪 · 🔴 红灯 = 意外 · 🟢 常亮 = 完成待审
- 它需要你选择时,卡片直接出现**可点的选项按钮**;请求敏感操作权限时,直接**批准/拒绝**;答案自动写回原会话。
- 干完后进工作区点"**审阅改动**"看 diff,满意就"**合并**",再一键"**收尾**"(停进程、清 worktree、归档)。

---

## 5. 配置项(可选)

### 环境变量(启动时设置)

| 变量 | 默认 | 说明 |
|---|---|---|
| `CCW_PORT` | `7080` | 监听端口 |
| `CCW_HOST` | `127.0.0.1` | 监听地址。**对外暴露前务必先看第 6 节** |
| `CCW_TOKEN` | 空 | 访问令牌;设置后 API 与 WebSocket 都要求它 |
| `CCW_ALLOWED_HOSTS` | 空 | 额外允许的 `host:port`(反向代理域名),逗号分隔 |
| `CCW_DATA_DIR` | `./.ccw-data` | 数据目录(会话、worktree、hooks、配置) |
| `CCW_BACKEND` | `auto` | `auto` 优先 tmux;`pty` 强制直接 PTY |
| `CCW_BROWSE_ROOTS` | home + 启动目录 | 目录浏览器可访问的根,冒号分隔;超出范围的路径返回 403 |

示例:

```bash
CCW_PORT=8123 CCW_TOKEN=$(openssl rand -hex 16) npm start
```

### 网页内设置

右下角"**通知设置**":配置**飞书群机器人 Webhook**(离开电脑也能收到塔台召唤),以及"完成待审是否也推送"。存于 `<数据目录>/config.json`。

---

## 6. 安全须知(重要)

- **默认只绑定 localhost**,并校验请求的 Host / Origin,防浏览器发起的 CSRF / DNS rebinding。仅本机使用无需额外配置。
- **想让别人/远程访问**,不要裸奔 `CCW_HOST=0.0.0.0`。正确做法:
  1. 设一个强 `CCW_TOKEN`;
  2. 把外部域名加进 `CCW_ALLOWED_HOSTS`;
  3. 前面架 HTTPS 反向代理(nginx/caddy),并开启 WebSocket upgrade 转发。
  首次打开网页会提示输入令牌(存 localStorage);令牌经 WebSocket 子协议传输,不落进 URL/日志。
- **权限模式 `bypassPermissions` 会放行 agent 的一切操作**(含删除、执行任意命令)。用它时务必配合独立 worktree 隔离;拿不准就用默认"每次询问",在网页上逐次批准。
- 终端逐键输入**不落盘**(可能含密码);只有显式的决策/权限/合并操作会记入时间线。
- 目录浏览接口只允许访问 home 与启动目录(或 `CCW_BROWSE_ROOTS`),经真实路径校验,防止遍历整机文件系统。
- 创建会话的"附加参数"会拒绝覆盖平台自有标志(`--settings` / `--mcp-config` / `--append-system-prompt` / `--permission-mode` 等),避免绕过状态采集与权限控制;权限模式仅接受已知取值。
- `.ccw-data/` 含 hooks 配置、会话状态,已被 `.gitignore` 忽略;凭据类文件以 `0600` 权限写入。

---

## 7. 常见问题

**Q:必须装 tmux 吗?**
不装也能跑,但 CCTower 服务重启/升级会杀掉所有会话进程。装了 tmux,会话托管在独立 tmux server 里,服务重启后自动重新接管——强烈建议装。

**Q:`npm install` 卡在 node-pty 编译报错?**
缺 C++ 工具链。macOS:`xcode-select --install`;Ubuntu/Debian:`sudo apt install build-essential python3`,再 `npm install`。

**Q:新建 Claude 会话提示 "Transcript saving is off"?**
CCTower 已自动剔除嵌套会话标记,正常不会出现。若你是从**另一个 Claude Code 里**启动的 CCTower 服务,换普通终端启动即可。

**Q:worktree 创建失败?**
项目目录不是 git 仓库、或还没有任何 commit 时,会自动降级为直接在项目目录运行,并在事件时间线给出冲突风险提示。想用隔离,先 `git init && git commit`。

**Q:会话名字对不上当前任务?**
会话名优先取 agent 上报的目标(每个任务开始刷新),其次是 Claude 的对话主题标题。想固定名字,在工作区直接改名——手动命名永远最高优先级。

**Q:网页卡住 / 终端无输入?**
右上角若显示"只读观察中",点"接管控制";或用侧栏"⟳ 刷新页面"、工作区"⟳ 刷新画面"。断线会自动重连,一般无需手动干预。

**Q:数据存在哪?怎么清空?**
全在 `.ccw-data/`(或 `CCW_DATA_DIR`)。停掉服务后删除该目录即可完全重置。

---

## 8. 维护与验证

```bash
npm test             # 运行测试(node:test,17 用例)
git pull && npm install   # 升级后如依赖有变
```

升级 CCTower:`git pull` 后重启服务。**有 tmux 的话,运行中的会话不受影响**,重启后自动接管;Claude 会话还会用 `--resume` 恢复原对话上下文。

---

## 9. 数据与目录速览

```
CCTower/
├── server/          # 后端:会话管理、Claude 集成、diff/合并、MCP 上报
├── public/          # 前端:无构建,原生 JS + xterm.js
├── test/            # node:test 用例
└── .ccw-data/       # 运行时数据(gitignore):sessions.json / config.json / worktrees / hooks
```

更完整的能力清单与架构见仓库根目录 [`README.md`](../README.md)。
