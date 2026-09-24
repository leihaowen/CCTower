# 远程访问网关(多机聚合)

把散落在多台服务器/家里主机上的 CCTower 聚合到**一个 HTTPS 域名**下,手机浏览器也能直接用,
NAT 后面(没有公网 IP)的机器也能接入——因为是机器主动"出站"连网关,不需要在本地开端口转发。

## 1. 它解决什么问题

- 你有好几台机器都跑着 CCTower,不想为每台单独开公网端口、配证书。
- 有些机器在 NAT/内网后面,没有公网 IP,传统反向代理够不着它。
- 想用手机浏览器,在外面也能看一眼、批一个权限请求。

网关方案:在一台有公网 IP 的服务器上跑「网关」,各台跑 CCTower 的机器上跑「agent」,
agent 主动向网关发起出站 WebSocket 连接(隧道),网关把浏览器请求通过隧道转发到对应机器的
CCTower(监听在回环地址,不直接对外暴露)。

## 2. 架构一图

```text
浏览器 → Caddy(TLS 终止,443) → 网关(Node,127.0.0.1:7081)
                                     ↕ 隧道(WebSocket,agent 主动出站建立)
                              agent(各台服务器) → 本机 CCTower(127.0.0.1:7080,回环)
```

- 网关是唯一的公网入口;各机 CCTower 全程只听回环,不直接暴露。
- 隧道由 agent 主动向网关连出,NAT/内网后的机器无需任何端口转发或公网 IP。

## 3. 部署网关

在一台有公网 IP、线路好的 VPS 上(国内访问优先选港/日/新加坡节点):

`deploy/cctower-gateway.service` 写死了以系统用户 `cctower` 运行,所以先建这个用户,
再以它的身份完成初始化——网关的数据目录默认是 `~/.cctower-gateway`(取运行用户的 home),
密码必须以 **将来跑服务的同一个用户** 设置,否则服务启动时读的是别的 home,会因为
"没有设置登录密码"直接退出:

```bash
# 1. 建系统用户,home 直接指到部署目录(不单独 --create-home,下一步 clone 会创建它)
sudo useradd --system --home-dir /opt/cctower --shell /usr/sbin/nologin cctower

# 2. 拉代码、装依赖(clone 出来默认是当前用户属主,记得 chown 给 cctower)
sudo git clone <repo> /opt/cctower
cd /opt/cctower && sudo npm ci --omit=dev
sudo chown -R cctower:cctower /opt/cctower

# 3. 以 cctower 身份设密码——这样 ~/.cctower-gateway 才会建在 /opt/cctower/.cctower-gateway
#    (由网关进程自己按 0700 创建,不用手建目录)
sudo -u cctower node gateway/cli.js set-password

# 4. 装 systemd 单元并启动
sudo cp deploy/cctower-gateway.service /etc/systemd/system/
sudo systemctl enable --now cctower-gateway
# 配好 Caddyfile 后
sudo systemctl reload caddy
```

网关只监听 `127.0.0.1:7081`;公网入口与 TLS 由前面的 Caddy 负责,配置示例见
[`deploy/Caddyfile.example`](../deploy/Caddyfile.example)(把里面的域名换成你自己的,
Caddy 会自动申请并续期证书)。

## 4. 添加一台服务器

在网关机器上生成这台服务器的接入 token:

```bash
node gateway/cli.js add-server aws1     # 打印 id 与 token(只显示这一次)
```

再到那台要接入的服务器上安装 agent:

```bash
sudo ./agent/install.sh wss://cc.example.com/tunnel <token> 7080
```

`agent/install.sh` 会把 `agent/` 部署到 `/opt/cctower-agent/app`、把其依赖的 `shared/` 复制到
与之同级的 `/opt/cctower-agent/shared`(agent 用相对路径 `require('../shared/tunnel/mux')`
引用它;两者都在 `cctower-agent` 专属命名空间下,不会碰到系统上任何既有的通用路径),
生成 `/etc/cctower-agent.json`,建一个不能登录的系统用户 `cctower-agent` 并把配置文件
`chown` 给它,再安装、以该用户身份启用 `cctower-agent` systemd 服务(见下面第 9 节)。

## 5. 升级已有 agent

在已经装过 agent 的机器上重跑 `install.sh`(比如拉了新版本代码、要改端口或 token)时,
脚本会把新代码拷到 `/opt/cctower-agent/app`、刷新 systemd 单元,并**显式重启**
`cctower-agent` 服务,让新代码真正跑起来(而不是仅仅 `enable`,因为对一个已经在跑的
单元,`enable`/`start` 都不会重启已存在的进程)。

如果这台机器是从更早、还没有做非 root 加固的版本升级上来的,`$BASE`(即
`/opt/cctower-agent`)下可能残留旧布局的文件(比如旧版本直接摆在 `$BASE` 根下的
`index.js`、`src/`、`node_modules/`,而不是现在的 `$BASE/app/...`)。这些残留不影响新版本
运行,但会白占磁盘、也容易在排障时误看成"当前生效的代码",建议手动确认并清理:

```bash
ls -la /opt/cctower-agent            # 确认只剩 app/ 与 shared/ 两个目录
```

## 6. 本机开了 CCW_TOKEN 怎么办

如果这台机器的 CCTower 本身设了 `CCW_TOKEN`(建议对外场景都设),agent 转发请求时也要带上它:
把同样的值填进 `/etc/cctower-agent.json` 的 `localToken` 字段,然后重启 agent:

```bash
sudo systemctl restart cctower-agent
```

> 之后如果要改网关地址、token 或端口而重跑 `install.sh`,不用担心这里填的 `localToken`
> 被清空——脚本会先读旧配置里的值,原样写回新文件。

## 7. 手机使用

浏览器打开网关域名 → 登录(网关密码,`gateway/cli.js set-password` 设置)→ 选服务器进入。
可以把页面"添加到主屏幕"当作快捷方式用。一期页面是桌面版布局,移动端专门适配放在二期。

## 8. 排障

- **卡片一直显示离线**:去对应服务器上查 agent 状态和日志
  ```bash
  systemctl status cctower-agent
  journalctl -u cctower-agent -n 50
  ```
- **点进去 502**:agent 在线,但本机 CCTower 没起来或端口不对,先自检
  ```bash
  curl -I http://127.0.0.1:7080/
  ```
- **登录后立刻被登出**:多半是用 `http` 而不是 `https` 访问网关——Secure cookie 在明文
  连接下存不住,线上必须走 HTTPS(Caddy 已经自动处理证书,直接用它前面的域名访问)。
- **忘了网关密码**:在网关机器上,以运行服务的同一个用户重设(否则改到别的 home 下,服务还是读不到)
  ```bash
  cd /opt/cctower && sudo -u cctower node gateway/cli.js set-password
  ```

## 9. 安全须知

- 网关是唯一的公网暴露面(Caddy 终止的 443);各机 CCTower 一律只监听回环,不对外开放端口。
- 删除一台服务器(`node gateway/cli.js remove-server <id>`)会立即吊销它的 token,
  对应隧道最迟在网关下一次心跳扫描时断开(默认约 15 秒内;要立即断开需重启网关进程)。
- 网关自己的数据目录默认在 `~/.cctower-gateway`(可用 `CCTOWER_GATEWAY_DATA` 覆盖),
  权限固定为 `0700`,存放服务器列表、token 哈希与登录密码哈希。
- agent 以专属系统用户 `cctower-agent` 运行(`install.sh` 自动创建,非 root、不能登录),
  单元额外加了 `ProtectSystem=strict`/`ProtectHome=true`/`PrivateTmp=true`:agent 是网关被
  攻破后唯一能碰到的枢轴点,以最小权限运行能把爆炸半径限制在这个账号能读到的东西
  (回环网络访问不受用户身份影响,配置文件已 `chown` 给它)。
- **多台被代理的 CCTower 与网关 UI 共用同一个 origin**(`/s/<id>/` 是路径式代理,不是子域名
  隔离):任一台机器上的 XSS,或一台被攻陷的机器,理论上都能借用户已登录的会话去调网关自身的
  `/api/overview`,或调其它机器的 `/s/<other-id>/api/...`。这是一期有意接受的取舍,详见规格
  `docs/superpowers/specs/2026-08-13-gateway-remote-access-design.md` §7。
