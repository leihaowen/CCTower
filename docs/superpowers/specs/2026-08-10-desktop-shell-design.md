# CCTower 桌面薄壳(方案 B)设计

日期:2026-08-10
状态:已获批准
范围:一期(M1 托盘+隧道+通知,M2 主窗口切换器)。二期"真聚合画布"另立规格。

## 背景与动机

CCTower 目前是"一台服务器一个 web 面板"。用户需要管理多台服务器上的
Claude/终端会话。经评估否决了"纯 SSH 客户端"(会失去服务端常驻监督与通知,
等于重新发明现有 server),选定混合方案:**服务端保持不动,桌面客户端只解决
连接与聚合**——自动维护 SSH 隧道、多服务器切换、系统通知。

## 已确认的需求决策

| 决策点 | 结论 |
| --- | --- |
| 聚合形态 | 分期:一期切换器,二期真聚合 |
| 目标平台 | macOS + Linux(用户主力 Mac,服务器全 Linux) |
| SSH 现状 | `~/.ssh/config` 已有别名+密钥,无跳板机,无密码/2FA |
| 常驻形态 | 菜单栏/托盘常驻 + 系统通知 + 角标 |
| 服务端部署职责 | 检测 + 一键启动(`systemctl --user start cctower`);不做安装/升级 |
| 壳技术 | Tauri 2,业务逻辑全 JS(官方插件 shell/tray/notification/store),Rust 仅脚手架 |

## 核心原则

1. **服务端零改动**。壳只消费现有 HTTP/WS 接口。
2. **UI 不打包进客户端**。每台服务器的页面通过隧道加载它自己伺服的前端,
   服务器间版本不一致不会坏,没有版本矩阵。
3. **不碰密钥**。隧道 spawn 系统 `ssh`,认证完全交给 ssh-agent / `~/.ssh/config`。

## 架构

仓库内新增 `desktop/` 子目录(monorepo,独立 package.json):

```
desktop/
  src-tauri/          # Rust 脚手架 + 插件注册,不含业务逻辑
  src/
    tunnel.js         # 隧道管理器
    servers.js        # 服务器注册表(tauri-plugin-store)
    bootstrap.js      # 远端 CCTower 检测 + 一键启动
    watcher.js        # 每服务器 WS 订阅 → 通知/角标/会话状态表
    tray.js           # 托盘菜单 + 角标
    main-window/      # 主窗口:侧栏 + per-server iframe
```

## 组件

### tunnel.js 隧道管理器

- 每台启用的服务器 spawn:
  `ssh -N -L {localPort}:127.0.0.1:{remotePort} -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 {alias}`
- `BatchMode=yes`:拿不到密钥立刻失败,绝不挂住等交互输入。
- 本地端口自动分配(实现细节,不暴露为用户配置);被占则换端口重试。
- 进程退出 → 指数退避重连:1s 起步,每次翻倍,封顶 30s。
- 对外暴露状态机:`connecting / up / auth-failed / down(retrying)`。

### servers.js 服务器注册表

- 存储:tauri-plugin-store 的本地 JSON。
- 字段:`{ name, sshAlias, remotePort = 7080, token?, enabled }`。
- `token` 仅当服务器设置了 `CCW_TOKEN` 时需要;经隧道访问回环地址,
  Host/Origin 校验天然通过,未设 token 的服务器无需任何凭据。

### bootstrap.js 检测 + 一键启动

- 隧道 `up` 但 HTTP 探活(`GET /`,经本地端口)失败 → 界面显示
  "CCTower 未运行" + 启动按钮。
- 启动按钮执行:`ssh {alias} 'systemctl --user start cctower'`,
  失败时把 stderr 原样展示给用户。
- 明确不做:安装、升级、卸载。

### watcher.js 通知订阅器

- 每台 `up` 的服务器建一条 WS(经隧道;有 token 时按现有子协议方式携带)。
- **通知**直接消费服务端现有的 `{type:'notify', id, name, reason, statusLine}`
  广播(与飞书推送同源,服务端已按 `lastNotified` 去重,壳不再自建去重逻辑)。
- **角标/状态表**消费 `{type:'session', session}` 广播,维护 per-server
  会话状态表 `{serverId → {sessionId → status}}`;注意力计数 =
  状态 ∈ `{needs_decision, needs_permission, blocked, review_ready}` 的会话数。
- 该状态表是唯一聚合数据源:托盘角标、侧栏计数、二期聚合画布都从它读。

### tray.js + 主窗口

- 托盘菜单:每台服务器一行(名称 + 注意力计数 + 连接状态点),
  点击 → 打开主窗口并切到该服务器;另有"退出"项。
- 托盘总角标 = 所有服务器注意力会话总数。
- 主窗口:左侧服务器列表(状态点 + 角标),右侧内容区为每台服务器一个
  iframe(加载 `http://127.0.0.1:{localPort}/`),显示/隐藏切换。
  xterm 与页面自己的 WS 在 iframe 内正常工作;服务器设了 token 时,
  页面自身的令牌输入流程(存 localStorage)原样生效。
- 关窗不退出,常驻托盘。

## 数据流

1. 启动:读配置 → 并行起全部隧道 → 探活 → 起 watcher → 刷新托盘。
2. 通知点击:聚焦主窗口 → 切到对应服务器。一期不做"直达会话"。
3. 一键启动:探活失败 → 用户点按钮 → 远程 systemctl → 重新探活。

## 与服务端的契约(唯一耦合点)

watcher 只依赖两类 WS 广播消息(已对照 `server/index.js` 现有实现核实):

- `{type:'notify', id, name, reason, statusLine}` —— 触发系统通知
- `{type:'session', session:{id, status, …}}`(删除时为
  `session:{id, deleted:true}`)—— 维护状态表与角标

以上字段视为服务端稳定契约,变更需同步修改本文档与壳。
其余消息类型(如 `tail`)与字段,壳一律不解析。

## 错误处理

| 场景 | 行为 |
| --- | --- |
| ssh 认证失败(BatchMode 拒绝) | 侧栏/托盘标红"密钥不可用,检查 ssh-agent";不自动重试轰炸 |
| 隧道断连 | 退避重连;连续失败超阈值弹一次通知,恢复时静默,不重复报 |
| 本地端口被占 | 自动换端口重试 |
| 远端 CCTower 未运行 | 显示未运行 + 一键启动按钮 |
| 一键启动失败 | 原样展示 stderr |

## 测试策略

- **单测**(仓库现有 `node --test` 风格):隧道状态机、退避计算、
  角标聚合、通知去重——全部拆成不依赖 Tauri 运行时的纯函数模块。
- **集成**:PATH 替身假 `ssh` 脚本模拟成功/认证失败/中途退出;
  本地起真 CCTower 实例做端到端(隧道 → 探活 → watcher → 通知触发)。
- **手动验收**:Mac 客户端 → Linux 服务器真机清单(添加服务器、断网重连、
  一键启动、通知点击跳转、多服务器切换)。

## 发布

- CI 用 tauri-action 构建 macOS dmg + Linux AppImage/deb。
- 签名/公证暂不做(个人使用 ad-hoc 签名);对外分发时再补。

## 里程碑

- **M1 托盘 + 隧道 + 通知**:无主窗口,点托盘项用系统浏览器打开
  `localhost:{localPort}` 兜底。此时已可日常使用。
- **M2 主窗口切换器**:侧栏 + iframe 切换,通知点击聚焦窗口。
- **二期(另立规格)**:真聚合画布——全服务器会话合并一屏,
  数据源复用 watcher 的会话状态表,会话 ID 加服务器命名空间。

## 明确不做(YAGNI)

- 服务端安装/升级托管
- 跳板机、密码、2FA 交互认证支持(现状无此需求)
- Windows 平台
- 客户端打包 CCTower 前端
- 一期的"通知直达会话"深链
