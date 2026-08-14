# CCTower 桌面客户端(实验性)

一个 Tauri 2 桌面壳:通过 SSH 隧道连接你已经在跑的 CCTower 服务端(Mac/Linux 桌面 → Linux 服务器),
托盘显示每台服务器的连接状态,主窗口内嵌网页版做终端操作,断线/服务端重启/服务器休眠都自动处理。

> 桌面壳本身不跑 CCTower 服务端,只是"隧道 + 状态感知的浏览器壳"。服务端该怎么部署还怎么部署,
> 见根目录 [`README.md`](../README.md) 与 [`docs/GETTING_STARTED.md`](../docs/GETTING_STARTED.md)。

## 前置要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 20 | 构建前端资源、跑测试 |
| Rust | 通过 [rustup](https://rustup.rs/) 安装 | Tauri 2 编译 native shell |
| 系统 `ssh` | 任意较新版本 | 隧道与一键启动命令都是真的调本机 `ssh` 二进制 |
| 目标服务器 | 已在 `~/.ssh/config` 配好别名,密钥可免密登录 | 桌面壳只认 `ssh <alias>`,不接受手填 host/port/密码 |

`~/.ssh/config` 示例:

```
Host myserver
  HostName 1.2.3.4
  User ubuntu
  IdentityFile ~/.ssh/id_ed25519
```

配好后先手动 `ssh myserver` 确认一次能免密连上、且远端 `systemctl --user start cctower` 能跑通,再交给桌面壳。

## 服务端版本要求

桌面壳经隧道访问 CCTower 服务端时,浏览器发出的 Host 头是隧道**本地端口**(如 `127.0.0.1:53421`),
不是服务端监听的端口;Tauri webview 的 Origin 还可能是 `tauri://localhost`。老版本 CCTower 服务端
的 Host/Origin 校验是固定端口白名单,会把这些请求当跨站请求拒绝(403),隧道能连上但页面打不开。

服务端需要包含 `server/authGuard.js` 里的 `isLoopbackHostHeader`(任意端口回环放宽,引入于
commit `f5afa17`)。本仓库当前版本已包含;用旧版服务端时,先 `git pull` 服务端仓库到该提交之后再部署。

这层放宽不影响安全模型:回环地址本来就打不到外网,任意端口只是把"固定端口"白名单放宽成
"只要是 127.0.0.1/localhost/`[::1]` 就行",不放行任何非回环来源(详见 `server/authGuard.js` 顶部注释)。

## 开发 / 构建 / 测试

```bash
npm install          # 装依赖
npm run tauri dev    # 开发模式,带热重载
npm run tauri build  # 打包成安装包(dmg/AppImage/deb 等,视平台而定)
npm test             # node:test,24 个用例(backoff/端口分配/服务器校验/隧道状态机/
                      # 假 ssh 集成/watcher 归约/托盘模型/真服务端契约)
```

## 配置服务器

两种方式,写的是同一份 store 文件:

1. **M2 主窗口表单**(推荐):打开应用,主窗口侧栏下方"添加服务器"表单,填 ssh 别名/名称/远端端口/token,
   提交后立即为该服务器建隧道,无需重启应用。
2. **命令行**(M1 遗留入口,CI/无头环境或批量导入时更方便):

   ```bash
   node scripts/add-server.mjs <sshAlias> [name] [remotePort] [token]
   ```

Store 文件路径(两种方式共用):

- macOS:`~/Library/Application Support/com.cctower.desktop/servers.json`
- Linux:`~/.config/com.cctower.desktop/servers.json`

`sshAlias` 只接受字母数字与 `. _ -`(且首字符必须是字母数字)——这既是 ssh 别名的合理约束,
也是参数注入的第一道防线(见下一节)。

## 重要:改 core/servers.js 的 argv 时必须同步改 capability

`src-tauri/capabilities/default.json` 里的 `shell:allow-spawn`(scope 名 `ssh-tunnel`)与
`shell:allow-execute`(scope 名 `ssh-run`)各自用一串按位置的正则 `validator` 精确匹配
`core/servers.js` 里 `sshTunnelArgs()` / `sshStartArgs()` 拼出的 `ssh` argv——Tauri shell 插件是
**按位置逐个校验参数**的白名单,不是校验最终命令行字符串。

这意味着:如果你改了 `sshTunnelArgs()` 或 `sshStartArgs()` 的参数顺序、数量,或新增/删除了某个
`-o` 选项,必须同步改 `default.json` 里对应 scope 的 `args` 数组,否则:

- 新增的参数位置没有 validator → Tauri 直接拒绝 spawn/execute(隧道建不起来,或一键启动没反应);
- 删掉的参数位置留了多余 validator → 校验失败,同样起不来。

两处保持逐位置严格对应是这套白名单机制的前提,不能只改一边。

## iframe 混合内容退路

主窗口内容区默认用 `<iframe src="http://127.0.0.1:<隧道本地端口>/">` 直连隧道(见
`src/shell/mainWindow.js` 的 `showServer()`)。如果某个 WKWebView(Mac)版本因为混合内容策略拒绝
加载这个 http iframe(壳本身跑在 `tauri://localhost`,理论上不算 https 页面套 http 的经典混合内容场景,
但不同 WebView2/WebKit 版本策略不完全一致),退路是:每台服务器改用独立的
`new WebviewWindow(id, { url: 'http://127.0.0.1:' + port })`——它的 origin 本身就是
`http://127.0.0.1`,不存在混合内容问题。届时主窗口侧栏只做列表与聚焦,`showServer()` 替换为
创建/聚焦对应 WebviewWindow,其余渲染/表单/事件逻辑不变。该退路的落点注释已经写在
`mainWindow.js` 对应位置,真遇到问题时直接照着改。

## 手动验收清单(Mac 客户端 → Linux 服务器)

M1/M2 自动化测试覆盖了状态机、参数拼接、假 ssh 集成与假 WS 契约,但真实 Mac + WKWebView + 真
ssh-agent 的组合无法在无显示的开发环境里跑,以下 9 条需要在实机上手动过一遍:

- [ ] 添加服务器后 30 秒内,托盘对应项显示"已连接"
- [ ] 服务器上停掉 cctower → 托盘变"CCTower 未运行" → 点一键启动 → 恢复"已连接"
- [ ] 断网 30 秒再恢复 → 隧道自动重连,不需要人工干预
- [ ] 把某会话手工标成"需要决策" → Mac 收到系统通知,托盘角标 +1
- [ ] 点通知/托盘项 → 主窗口聚焦并显示该服务器页面,终端可输入
- [ ] 侧栏在两台服务器之间切换,iframe 状态各自保持(不重载)
- [ ] 删除 ssh-agent 里的密钥 → 该服务器标红"密钥不可用",不无限重试
- [ ] 退出应用 → `ps aux | grep 'ssh -N'` 无残留隧道进程
- [ ] M2 主窗口表单添加一台新服务器 → 无需重启应用,立即为其建隧道并出现在侧栏

## 目录速览

```
desktop/
├── src/core/     # 纯逻辑:backoff/ports/servers/tunnel 状态机/watcher 归约/trayModel(无 Tauri 依赖,单测覆盖)
├── src/node/     # Node 版 spawn 适配(假 ssh 集成测试用)
├── src/shell/    # Tauri 适配层:store/tray/notify/probe/sshExec/wsClient/mainWindow/app 组装
├── src-tauri/    # Rust + Tauri 配置,capabilities/default.json 是 shell 命令白名单
├── scripts/      # add-server.mjs:命令行配置入口
└── test/         # node:test 用例,24 个
```
