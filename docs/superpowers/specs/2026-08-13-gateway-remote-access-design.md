# CCTower 远程访问网关(一期)设计规格

日期:2026-08-13
状态:已获用户批准的设计,待实施计划

## 1. 背景与产品定位

CCTower 目前是"一台服务器一个 Web 面板"的自用工具,只能在本机/局域网访问。用户的目标分四期演进:

1. **一期(本规格)**:自用远程——用户本人在任何网络(含手机浏览器)监管自己的多台服务器
2. 二期:手机 PWA + Web Push(监控 + 回复决策,不做手机终端)
3. 三期:多账号注册/登录,用户自助添加自己的服务器
4. 四期:托管机器分配(AWS AMI + API 开机 / 容器多租户)+ 计费,成为 SaaS

一期的所有架构决策必须让二、三、四期只做加法、不做重构。已确认的环境约束:服务器混合(有公网 IP 的云机器 + NAT 后内网机器),人在国内、服务器多在海外,手机 iOS 与 Android 都要支持。

方案选型已定:**自建汇聚网关**(否决了 Tailscale/headscale 组网路线——手机需常开 VPN、无 Web Push、无法向多租户 SaaS 演进)。

## 2. 一期目标与成功标准

- 用户在任何网络的浏览器(含手机)打开 `https://<网关域名>/`,登录后看到所有服务器的聚合总览,点击任一服务器进入其完整的现有 CCTower UI(含终端)
- NAT 后与公网服务器接入方式完全一致:装 agent、填网关地址和 token,一条命令
- 唯一公网暴露面是网关的 443;各服务器 CCTower 继续只监听 127.0.0.1
- 服务器掉线/网关重启均自动恢复,无需人工干预

## 3. 架构总览

```
手机/电脑浏览器 ──HTTPS──▶ 网关 VPS:Caddy(443,TLS)──▶ gateway(Node,127.0.0.1:7081)
                                        ▲
                                        │ 出站 WSS 隧道(每台服务器一条,自动重连)
                        ┌───────────────┼───────────────┐
                  agent(NAT 机器)  agent(云机器)   agent(未来托管容器)
                        │ 回环           │回环            │回环
                  CCTower:7080     CCTower:7080     CCTower:7080
```

新增三个组件,全部 Node.js,放在仓库新目录;CCTower 服务端逻辑零改动,前端仅做"前缀感知"小改(见 §8)。

| 组件 | 目录 | 依赖 | 职责 |
|------|------|------|------|
| gateway | `gateway/` | 复用仓库根依赖(express、ws)+ Node 内置 crypto | 认证、服务器注册表、反向代理、聚合总览 |
| agent | `agent/` | 独立 `agent/package.json`,唯一依赖 ws | 装在每台服务器,出站连网关,转发到本机 CCTower |
| 隧道协议 | `shared/tunnel/` | 无 | 帧编解码 + 流多路复用,gateway 与 agent 共用 |

TLS 由 Caddy 负责(自动 Let's Encrypt),gateway 只监听回环。不内置证书管理(产品化再议)。

## 4. 隧道协议(`shared/tunnel/`)

一条 WebSocket 上多路复用任意数量的逻辑流(stream)。

**控制帧**(WS text frame,JSON):

```json
{ "streamId": 7, "kind": "open", "meta": { "type": "http", "method": "GET", "path": "/api/sessions", "headers": {…} } }
{ "streamId": 7, "kind": "headers", "meta": { "status": 200, "headers": {…} } }
{ "streamId": 7, "kind": "end" }
{ "streamId": 7, "kind": "error", "meta": { "message": "…" } }
{ "streamId": 0, "kind": "ping" }   / { "streamId": 0, "kind": "pong" }
```

- `open` 的 `meta.type` 取值 `http`(短命流:请求→响应)或 `ws`(长命流:双向透传,`meta.protocols` 携带子协议列表)
- **数据帧**(WS binary frame):前 4 字节大端 streamId + 负载字节
- streamId 由 gateway 侧分配,单调递增,0 保留给心跳
- 心跳:双方每 15 秒发 ping,30 秒收不到任何帧即判死、主动断开
- 流终止:`end`(正常)或 `error`(异常);任一侧收到后必须释放该流资源;WS 连接断开时双方清理全部流

## 5. agent(`agent/`)

- 配置文件 `/etc/cctower-agent.json`:`{ "gatewayUrl": "wss://cc.example.com/tunnel", "token": "…", "localPort": 7080, "localToken": "" }`(环境变量 `CCTOWER_AGENT_CONFIG` 可改路径)
- 启动即连 `gatewayUrl`,请求头 `Authorization: Bearer <token>`;断线指数退避重连(1s 起,×2,封顶 30s,成功后归零)
- 收到 `open http` → 对 `http://127.0.0.1:<localPort><path>` 发起请求,流式回传响应
- 收到 `open ws` → 对本机同路径建立 WebSocket,双向搬运数据帧
- **本机认证注入**(已对照 `server/index.js`/`authGuard.js` 核实):CCTower 默认回环监听时 `CCW_TOKEN` 可不设,此时 agent 无需注入任何凭据;若该机设置了 `CCW_TOKEN`,把同值填入 agent 配置的 `localToken`,agent 对转发的 HTTP 请求注入 `X-CCW-Token` 头、对 WS 注入 `ccw.token.<base64url>` 子协议,并从转发流量中剥离浏览器可能带来的同名头/子协议。本机 token 永不出机器
- **请求净化**:重写 `Host` 为 `127.0.0.1:<localPort>`,剥离 `Origin`/`Referer`,避免触发服务端本机来源校验;其余头原样透传
- 交付 systemd 单元 `cctower-agent.service` + `agent/install.sh`(参数:网关地址、token;此脚本即三期"用户自助添加服务器"的雏形)

## 6. gateway(`gateway/`)

### 6.1 注册表与配置

- 数据目录 `~/.cctower-gateway/`(环境变量 `CCTOWER_GATEWAY_DATA` 可改):
  - `config.json`:`{ "port": 7081, "passwordHash": "…", "sessionSecret": "…" }`(首次启动自动生成 sessionSecret)
  - `servers.json`:`[{ "id", "name", "tokenHash", "addedAt", "lastSeenAt" }]`,原子写(临时文件 + rename)
- token:32 字节随机,base64url 明文只在创建时打印一次;存 SHA-256 哈希
- 密码哈希:Node 内置 `crypto.scrypt`(N=16384, r=8, p=1),格式 `scrypt$<salt-b64>$<hash-b64>`;不引入 bcrypt 依赖
- CLI `gateway/cli.js`:
  - `add-server <name>` → 打印 serverId + 接入 token(仅此一次)
  - `list-servers` / `remove-server <id>`(移除即吊销,在线隧道立即断开)
  - `set-password`(交互输入,写入 scrypt 哈希)

### 6.2 认证与会话

- `GET /login` 登录页;`POST /api/login` 校验密码 → 下发 cookie `ccgw_session`
- cookie:HMAC-SHA256 签名令牌(`base64url(payload).sig`,payload 含过期时间),`HttpOnly; Secure; SameSite=Lax; Max-Age=604800`(7 天)
- 登录限速:每 IP 每分钟最多 5 次失败,超出后本分钟直接 429;实现用内存滑动窗口即可
- 除 `/login`、`/api/login`、`/tunnel` 外的所有路由要求有效会话,否则 302 到 `/login`(API 请求返回 401 JSON)
- **账号模型预留**:路由层统一经 `visibleServers(session)` 过滤,一期恒返回全部;三期加多账号时该函数换实现即可
- CSRF:依赖 SameSite=Lax(阻止跨站携带 cookie 的 POST),一期不加 token,规格明确记录此取舍

### 6.3 反向代理

- `GET /s/:serverId` → 301 补尾斜杠 `/s/:serverId/`(保证相对路径资源解析正确)
- `/s/:serverId/*`:去掉前缀后经该服务器隧道转发(HTTP 与 WS 升级都支持);流式、不缓冲
- 目标服务器离线 → 502 友好页("该服务器离线,agent 会自动重连",含最后在线时间)
- `/tunnel`:agent 接入点,校验 `Authorization: Bearer` 的 SHA-256 是否命中注册表;同一 serverId 重复连接时新连接踢掉旧连接

### 6.4 聚合总览

- `GET /` 总览页(新页面,`gateway/public/`):每台服务器一张卡片——在线/离线、各状态会话计数、"需注意"角标(等待输入/出错等)、最后在线时间;点卡片进 `/s/<id>/`
- 数据来源:gateway 对每条在线隧道内部发起对该机 `/ws/events` 的订阅(走与代理相同的 ws 流),用消息 `snapshot` / `session` / `notify` 维护内存态;归并逻辑**移植**自桌面壳一期的 `desktop/src/core/watcher.js`(PR #2 已合并,该文件在 main 上;它是 ESM 而仓库根是 CJS——实施时把该模块连同其测试转为 CJS 复制到 `gateway/src/watcher.js`,消息契约已在桌面壳一期对照真实服务端验证过)
- 前端轮询 `GET /api/overview`(3 秒间隔)获取聚合 JSON;一期不做总览 WS 推送
- 订阅流断开只影响该服务器卡片(标记"数据过期"),代理通道独立不受影响;订阅自动随隧道重连恢复

## 7. 安全模型

| 层 | 措施 |
|----|------|
| 传输 | Caddy 强制 HTTPS/WSS;agent 校验网关证书(默认开启,不提供关闭开关) |
| 浏览器认证 | scrypt 密码 + 签名会话 cookie(HttpOnly/Secure/Lax,7 天)+ 登录限速 |
| agent 认证 | 每机独立 32 字节 token,网关只存哈希;删除记录即吊销 |
| 纵深 | 各机 CCTower 仅监听 127.0.0.1;本机 token 由 agent 注入,不出机器;网关被攻破 ≠ 拿到服务器 SSH |
| 隔离预留 | 所有路由经 `visibleServers(session)`,为三期多租户预留 |

一期有意不做:TOTP(三期随账号体系)、网关高可用(单点,agent 自愈重连)、审计日志。

## 8. 现有代码改动(唯一改动面:前端前缀感知)

现有前端全部用绝对路径,收口点已核实:

1. `public/app.js`:顶部新增 `const PREFIX = location.pathname.replace(/\/(index\.html)?$/, '')`;`api()` 帮助函数与所有直接 `fetch('/api/…')`(如 `/api/health`)统一改为拼接 `PREFIX`;两处 `new WebSocket(…)` 的路径同样拼接
2. `public/index.html` 与 `canvas.js`:静态资源引用(`/style.css`、`/vendor/…`、`/app.js` 等)改为相对路径;实施时 grep 清点全部绝对引用
3. 直连本机(路径 `/`,PREFIX 为空串)行为不变,**向后兼容**

服务端(`server/`)零改动;不依赖 desktop-shell 分支的回环 Host 放宽(agent 以正常回环 Host 访问)。

## 9. 错误处理与降级

- 服务器掉线:卡片变灰 + 最后在线时间;`/s/<id>/*` 返回 502 页
- 网关重启:状态全在磁盘,agent 30 秒内退避重连,自愈
- 隧道半死:15s ping / 30s 超时判死重连(双向)
- 聚合订阅与代理通道互相独立,单边故障不传染
- 飞书通知维持现状(各服务器直发,不经网关)——网关故障不影响通知,是特性而非缺陷

## 10. 测试

沿用仓库测试模式(`node --test`,脚本 glob 不带引号):

- **单测**:隧道帧编解码、多路复用与流清理(含连接断开时的全量清理)、注册表 CRUD 与原子写、token 生成/哈希校验、scrypt 校验、会话签发/校验/过期、登录限速、PREFIX 推导、watcher 聚合归并(gateway 侧新增用例)
- **集成**:进程内 gateway ↔ 真 agent ↔ 真 `server/index.js`(参照桌面壳一期 contract e2e 手法):登录 → `/api/overview` → 经 `/s/<id>/` 代理调 API → WS 终端透传往返 → 杀 agent 验证 502 与卡片离线 → 重启 agent 验证自愈
- **安全回归**:未登录 401/302、错误 agent token 拒连、限速 429、cookie 属性断言、被吊销 token 的在线隧道被断开
- 测试位置:gateway 与隧道协议、集成/安全用例放根 `test/`(命名 `gateway-*.test.js` / `tunnel-*.test.js`,随根 `npm test` 运行,与仓库现有 CJS 风格一致);agent 用例放 `agent/test/`,由 `npm test --prefix agent` 运行
- CI 新增 `gateway-test` job:root `npm ci` → root `npm test` → `npm ci --prefix agent` → `npm test --prefix agent`

## 11. 部署交付

- `deploy/cctower-gateway.service`(systemd)+ `deploy/Caddyfile.example`
- `agent/install.sh` + `deploy/cctower-agent.service`
- `docs/GATEWAY.md`:网关部署步骤(VPS 选型提示:国内访问优先港/日/新加坡线路)、添加服务器流程、手机使用说明(浏览器打开 → 登录 → 可添加到主屏幕;一期为桌面版页面,移动适配在二期)

## 12. 一期明确不做(YAGNI)

手机 PWA/Web Push(二期);移动端 UI 适配(二期);多账号注册/登录(三期);Web 端添加服务器界面(三期);托管机器分配、容器多租户、计费(四期);桌面壳对接网关;网关级飞书通知;TOTP;网关高可用;审计日志;CSRF token(SameSite=Lax 兜底,已记录取舍)。

## 13. 开发方式约束

- 新分支 `worktree-gateway`(基于 main),worktree 隔离开发,完成后开 PR 等用户验收,**不直接合 main**
- 所有提交须 `-s` 签署(仓库启用 DCO 机器人)
- Node ≥ 20;gateway 复用根依赖,agent 独立最小依赖(仅 ws);不引入其他运行时依赖
