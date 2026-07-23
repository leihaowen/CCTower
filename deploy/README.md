# 部署为常驻服务(systemd)

把 CCTower 交给 systemd 托管:开机自启、进程崩了自动拉起、可跟随日志。
本目录提供 systemd unit 模板 [`cctower.service`](./cctower.service)。

> 平台:Linux(有 systemd)。macOS 用 `launchd`,可参考本文思路自行改写 plist。

---

## 为什么用 user 服务(推荐)

CCTower 通过 `node-pty` 拉起 **claude CLI**,必须以**你自己的账号**、带**正确的 PATH**(能找到 `claude`、`git`)运行。
用 root 的系统服务会让 claude 会话创建失败。所以推荐 **user 级 systemd 服务**:

```bash
# 1. 拷贝模板
mkdir -p ~/.config/systemd/user
cp deploy/cctower.service ~/.config/systemd/user/cctower.service

# 2. 填占位符(见下)
${EDITOR:-vi} ~/.config/systemd/user/cctower.service

# 3. 允许不登录也常驻 + 开机自起
loginctl enable-linger "$USER"

# 4. 启用并启动
systemctl --user daemon-reload
systemctl --user enable --now cctower

# 5. 确认
systemctl --user status cctower
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:7080/
```

### 三个占位符怎么填

| 占位符 | 含义 | 查法 |
|---|---|---|
| `__CCTOWER_DIR__` | 仓库绝对路径 | 在仓库里执行 `pwd` |
| `__NODE_BIN__` | node 绝对路径 | `command -v node` |
| `__PATH__` | 你 shell 的 PATH,**必须含 claude/git 所在目录** | `echo $PATH` |

一条命令自动替换(在仓库根目录执行):

```bash
sed -e "s#__CCTOWER_DIR__#$(pwd)#g" \
    -e "s#__NODE_BIN__#$(command -v node)#g" \
    -e "s#__PATH__#$PATH#g" \
    deploy/cctower.service > ~/.config/systemd/user/cctower.service
```

---

## 常用命令

```bash
systemctl --user status cctower        # 状态
systemctl --user restart cctower       # 重启(改了代码后需手动重启)
systemctl --user stop cctower          # 停止
systemctl --user disable --now cctower # 停止并取消自启
journalctl --user -u cctower -f        # 实时日志
systemctl --user reset-failed cctower  # 崩溃循环停到 failed 后恢复
```

## 验证自动拉起

```bash
kill -9 "$(systemctl --user show -p MainPID --value cctower)"
sleep 5
systemctl --user is-active cctower      # 应输出 active(PID 已变)
```

---

## 改配置

端口 / 绑定地址 / 令牌等在 unit 的 `[Service]` 段用 `Environment=` 配置
(全部变量见 [`docs/GETTING_STARTED.md`](../docs/GETTING_STARTED.md) 第 5 节)。改完:

```bash
systemctl --user daemon-reload && systemctl --user restart cctower
```

**对外暴露**务必先读 GETTING_STARTED 第 6 节:设强 `CCW_TOKEN`、配 `CCW_ALLOWED_HOSTS`、前置 HTTPS 反代。

---

## 系统级服务(仅在必须开机即起、无人登录时)

若确实需要不依赖任何用户会话,可放到 `/etc/systemd/system/cctower.service`,
但**必须**指定运行账号,否则 claude 会话起不来:

```ini
[Service]
User=youruser
Group=youruser
# 其余字段同模板;PATH 用该账号的 PATH
```

```bash
sudo cp cctower.service /etc/systemd/system/cctower.service
sudo systemctl daemon-reload
sudo systemctl enable --now cctower
sudo systemctl status cctower
```

> 多数场景用 `loginctl enable-linger` 的 user 服务已足够(开机自起、无需登录),更简单也更安全,优先选它。
