#!/usr/bin/env bash
# CCTower 部署脚本 —— 在目标机器上、以目标用户身份运行。
#
# 用法(本机):
#   bash deploy/install.sh [选项]
#
# 用法(远程,仓库由脚本自己 clone;先传过去再跑,别用 `bash -s <` 走 stdin,会被子进程吞掉):
#   scp deploy/install.sh user@192.0.2.10:/tmp/ && ssh user@192.0.2.10 'bash /tmp/install.sh --host 127.0.0.1'
#
# 选项:
#   --dir PATH            安装目录            (默认 ~/ccw)
#   --repo URL            git 仓库地址        (默认 https://github.com/leihaowen/CCTower.git)
#   --bundle FILE         从 git bundle 取代码(离线/GitHub 不通时用,见 remote-install.sh)
#   --bundle-ref NAME     bundle 里的源 ref  (默认 refs/heads/<branch>)
#   --branch NAME         分支                (默认 main)
#   --service NAME        systemd 服务名      (默认 cctower)
#   --port N              CCW_PORT            (默认 7080)
#   --host ADDR           CCW_HOST            (默认 127.0.0.1)
#   --token STR           CCW_TOKEN           (对外暴露时必填)
#   --gen-token           自动生成 32 字节随机令牌
#   --allowed-hosts LIST  CCW_ALLOWED_HOSTS   (逗号分隔的 host:port)
#   --backend auto|pty    CCW_BACKEND         (默认不设,即 auto)
#   --skip-deps           跳过依赖检查
#   --no-linger           不开 loginctl enable-linger
#   --no-start            只装不启动
#
# 幂等:重复执行会 pull 最新代码、重装依赖、重写 unit 并 restart。
set -euo pipefail

DIR="$HOME/ccw"
REPO="https://github.com/leihaowen/CCTower.git"
BUNDLE=""
BUNDLE_REF=""
BRANCH="main"
SERVICE="cctower"
PORT="7080"
HOST="127.0.0.1"
TOKEN=""
ALLOWED_HOSTS=""
BACKEND=""
SKIP_DEPS=0
DO_LINGER=1
DO_START=1

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)           DIR="$2"; shift 2 ;;
    --repo)          REPO="$2"; shift 2 ;;
    --bundle)        BUNDLE="$2"; shift 2 ;;
    --bundle-ref)    BUNDLE_REF="$2"; shift 2 ;;
    --branch)        BRANCH="$2"; shift 2 ;;
    --service)       SERVICE="$2"; shift 2 ;;
    --port)          PORT="$2"; shift 2 ;;
    --host)          HOST="$2"; shift 2 ;;
    --token)         TOKEN="$2"; shift 2 ;;
    --gen-token)     TOKEN="__GEN__"; shift ;;
    --allowed-hosts) ALLOWED_HOSTS="$2"; shift 2 ;;
    --backend)       BACKEND="$2"; shift 2 ;;
    --skip-deps)     SKIP_DEPS=1; shift ;;
    --no-linger)     DO_LINGER=0; shift ;;
    --no-start)      DO_START=0; shift ;;
    -h|--help)       sed -n '2,30p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "未知选项:$1(用 --help 看用法)" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1;36m[%s]\033[0m %s\n' "$1" "$2"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\n\033[1;31m✗ 部署失败:%s\033[0m\n' "$1" >&2; shift; for l in "$@"; do printf '    %s\n' "$l" >&2; done; exit 1; }

# ---------------------------------------------------------------- 1. 预检
step 1/6 "预检环境"

[ "$(uname -s)" = "Linux" ] || die "本脚本只支持 Linux(有 systemd)" "macOS 请用 launchd,参考 deploy/README.md 自行改写 plist。"
command -v systemctl >/dev/null || die "找不到 systemctl" "本脚本依赖 systemd user 服务。"
systemctl --user show-environment >/dev/null 2>&1 \
  || die "systemd --user 不可用(当前会话没有 user manager)" \
         "如果你是通过 ssh 非登录方式跑的,先确认:" \
         "  loginctl enable-linger $USER" \
         "然后重新登录一次再执行本脚本。"
ok "systemd user 可用"

if [ "$SKIP_DEPS" = 0 ]; then
  command -v node >/dev/null || die "未安装 Node.js" "需要 Node.js ≥ 20。"
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAJOR" -ge 20 ] || die "Node.js 版本过低:$(node -v)" "CCTower 要求 ≥ 20。"
  ok "node $(node -v)"

  command -v npm >/dev/null || die "未安装 npm"
  ok "npm $(npm -v)"

  command -v git >/dev/null || die "未安装 git" "worktree 隔离、diff 审阅、一键合并都依赖它。"
  ok "git $(git --version | awk '{print $3}')"

  if command -v tmux >/dev/null; then
    ok "tmux $(tmux -V | awk '{print $2}')"
  else
    warn "未装 tmux —— 会降级为直接 PTY:CCTower 服务一重启,所有会话进程就没了。"
    warn "强烈建议:sudo apt install -y tmux,然后重跑本脚本。"
  fi

  MISSING_TOOLCHAIN=""
  for t in cc make python3; do command -v "$t" >/dev/null || MISSING_TOOLCHAIN="$MISSING_TOOLCHAIN $t"; done
  if [ -n "$MISSING_TOOLCHAIN" ]; then
    warn "缺少 C++ 工具链:$MISSING_TOOLCHAIN —— node-pty 是原生模块,npm install 可能编译失败。"
    warn "Debian/Ubuntu:sudo apt install -y build-essential python3"
  else
    ok "C++ 工具链齐全(node-pty 可编译)"
  fi
fi

# ---------------------------------------------------------------- 2. 暴露面校验(与 server/authGuard.js 同规则,提前拦住)
step 2/6 "校验暴露面与令牌"

if [ "$TOKEN" = "__GEN__" ]; then
  # 升级 = 重跑同一条命令:已部署过就沿用旧令牌,否则每次升级都会让已保存令牌的浏览器全部失效。
  OLD_TOKEN="$(sed -n 's/^Environment=CCW_TOKEN=//p' "$HOME/.config/systemd/user/$SERVICE.service" 2>/dev/null | tail -1 || true)"
  if [ -n "$OLD_TOKEN" ]; then
    TOKEN="$OLD_TOKEN"
    ok "沿用已部署的令牌(要轮换请用 --token '<新令牌>')"
  else
    if command -v openssl >/dev/null; then TOKEN="$(openssl rand -hex 24)"
    else TOKEN="$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"; fi
    GENERATED_TOKEN=1
  fi
fi

case "$HOST" in
  127.*|localhost|::1|"[::1]") EXPOSED=0 ;;
  *) EXPOSED=1 ;;
esac
[ -n "$ALLOWED_HOSTS" ] && EXPOSED=1

if [ "$EXPOSED" = 1 ] && [ -z "$TOKEN" ]; then
  die "对外可达但没有令牌(服务端也会拒绝启动)" \
      "CCW_HOST=$HOST${ALLOWED_HOSTS:+ / CCW_ALLOWED_HOSTS=$ALLOWED_HOSTS} 意味着任何能连到这个端口的人" \
      "都可以创建会话、在这台机器上执行任意命令。请二选一:" \
      "  加令牌:  --gen-token  (或 --token '<32位以上随机串>')" \
      "  只本机:  --host 127.0.0.1  然后用 SSH 隧道访问(推荐)"
fi
if [ "$EXPOSED" = 1 ] && [ "${#TOKEN}" -lt 16 ]; then
  warn "令牌只有 ${#TOKEN} 个字符,建议至少 16 位(服务端会告警但仍启动)。"
fi
if [ "$EXPOSED" = 1 ] && ! echo ",$ALLOWED_HOSTS," | grep -q ":$PORT,"; then
  warn "CCW_ALLOWED_HOSTS 里似乎没有 <访问用的 host>:$PORT —— 浏览器直连会吃 403。"
  warn "例如局域网直连要加:--allowed-hosts \"\$(hostname -I | awk '{print \$1}'):$PORT\""
fi
if [ "$EXPOSED" = 0 ]; then
  ok "只绑回环($HOST),无需令牌;用 SSH 隧道访问"
else
  ok "对外可达($HOST),已配置令牌"
fi

# claude CLI:非登录 shell 的 PATH 常常没有 ~/.local/bin,所以要主动找
CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
for c in "$HOME/.local/bin/claude" "$HOME/.npm-global/bin/claude" "$HOME/.bun/bin/claude"; do
  [ -n "$CLAUDE_BIN" ] && break
  [ -x "$c" ] && CLAUDE_BIN="$c"
done
if [ -z "$CLAUDE_BIN" ]; then
  warn "没找到 claude CLI —— 终端会话能用,但 Claude Code 会话创建会失败。"
  warn "装好并登录后重跑本脚本即可(CCTower 复用本机已登录的 CLI,不要 API Key)。"
elif [ ! -s "$HOME/.claude/.credentials.json" ] && ! grep -q '"oauthAccount"' "$HOME/.claude.json" 2>/dev/null; then
  warn "claude 已安装($CLAUDE_BIN)但看起来没登录 —— 先在这台机器上跑一次 claude 完成登录。"
else
  ok "claude 已安装并登录($("$CLAUDE_BIN" --version 2>/dev/null | head -1))"
fi

# ---------------------------------------------------------------- 3. 取代码
step 3/6 "获取代码到 $DIR"

# 为什么强制 HTTP/1.1:某些网络里 github.com 前面有代理/MITM(DNS 返回非 GitHub 的 IP),
# git 默认的 HTTP/2 会静默挂死到超时,而 HTTP/1.1 秒过。对正常网络无副作用。
GITC=(git -c http.version=HTTP/1.1)

if [ -n "$BUNDLE" ]; then
  [ -f "$BUNDLE" ] || die "找不到 bundle 文件:$BUNDLE"
  # 用 list-heads 而不是 verify:verify 必须在一个 git 仓库里跑,而这里 cwd 通常是 $HOME。
  "${GITC[@]}" bundle list-heads "$BUNDLE" >/dev/null 2>&1 \
    || die "bundle 不可读或已损坏:$BUNDLE" "重新生成一份(deploy/remote-install.sh 会自动做)。"
  [ -n "$BUNDLE_REF" ] || BUNDLE_REF="refs/heads/$BRANCH"
  ok "使用离线 bundle:$BUNDLE($BUNDLE_REF)"
fi

# 网络取源时带重试:代理抽风是常态,一次失败不代表真不通
fetch_remote() {
  local what="$1"; shift
  local i
  for i in 1 2 3; do
    if "$@"; then return 0; fi
    warn "$what 第 $i 次失败,3 秒后重试…"
    sleep 3
  done
  return 1
}

if [ -d "$DIR/.git" ]; then
  if [ -n "$(git -C "$DIR" status --porcelain --untracked-files=no)" ]; then
    die "$DIR 有未提交的改动,拒绝覆盖" "先处理掉再重跑,或换个 --dir。"
  fi
  if [ -n "$BUNDLE" ]; then
    "${GITC[@]}" -C "$DIR" fetch --quiet "$BUNDLE" "$BUNDLE_REF" || die "从 bundle 取 $BUNDLE_REF 失败"
    git -C "$DIR" checkout --quiet -B "$BRANCH" FETCH_HEAD
  else
    fetch_remote "git fetch" "${GITC[@]}" -C "$DIR" fetch --quiet "$REPO" "refs/heads/$BRANCH" \
      || die "git fetch 失败" "这台机器连不上 $REPO。" \
             "排查:git -c http.version=HTTP/1.1 ls-remote $REPO HEAD" \
             "GitHub 不通时改用离线方式:在有代码的机器上跑 deploy/remote-install.sh"
    git -C "$DIR" checkout --quiet -B "$BRANCH" FETCH_HEAD
  fi
  git -C "$DIR" remote set-url origin "$REPO" 2>/dev/null || git -C "$DIR" remote add origin "$REPO"
  ok "已更新到 $BRANCH @ $(git -C "$DIR" rev-parse --short HEAD)"
else
  if [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
    die "$DIR 已存在且非空,也不是 git 仓库" "换个 --dir,或先清空它。"
  fi
  if [ -n "$BUNDLE" ]; then
    mkdir -p "$DIR"
    git -C "$DIR" init --quiet
    "${GITC[@]}" -C "$DIR" fetch --quiet "$BUNDLE" "$BUNDLE_REF:refs/heads/$BRANCH" \
      || die "从 bundle 取 $BUNDLE_REF 失败" "确认 bundle 里有这个 ref:git bundle list-heads $BUNDLE"
    git -C "$DIR" checkout --quiet "$BRANCH"
    git -C "$DIR" remote add origin "$REPO"
  else
    fetch_remote "git clone" "${GITC[@]}" clone --quiet --branch "$BRANCH" "$REPO" "$DIR" \
      || die "git clone 失败" "这台机器连不上 $REPO。" \
             "排查:git -c http.version=HTTP/1.1 ls-remote $REPO HEAD" \
             "GitHub 不通时改用离线方式:在有代码的机器上跑 deploy/remote-install.sh"
  fi
  ok "已获取 $BRANCH @ $(git -C "$DIR" rev-parse --short HEAD)"
fi

# ---------------------------------------------------------------- 4. 装依赖
step 4/6 "安装 npm 依赖(node-pty 需本地编译,可能要一会儿)"

cd "$DIR"
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund 2>&1 | tail -5 || {
    warn "npm ci 失败,回退 npm install"
    npm install --no-audit --no-fund 2>&1 | tail -5 || die "npm 依赖安装失败" "多半是 node-pty 编译缺工具链:sudo apt install -y build-essential python3"
  }
else
  npm install --no-audit --no-fund 2>&1 | tail -5 || die "npm 依赖安装失败"
fi
node -e 'require("node-pty")' 2>/dev/null && ok "node-pty 可加载" || die "node-pty 装好了但加载失败" "通常是编译产物与当前 node ABI 不匹配:rm -rf node_modules && 重跑本脚本。"

# ---------------------------------------------------------------- 5. 写 systemd unit
step 5/6 "生成 systemd user 服务:$SERVICE"

# node-pty 拉起 claude/git 需要完整 PATH。非登录 shell 的 PATH 往往缺 ~/.local/bin,
# 所以合并:登录 shell 的 PATH + 当前 PATH + 各关键二进制所在目录,去重。
LOGIN_PATH="$(bash -lc 'echo -n $PATH' 2>/dev/null || true)"
EXTRA_DIRS=""
for b in node npm git tmux "$CLAUDE_BIN"; do
  [ -n "$b" ] || continue
  p="$(command -v "$b" 2>/dev/null || echo "$b")"
  [ -x "$p" ] && EXTRA_DIRS="$EXTRA_DIRS:$(dirname "$(readlink -f "$p")"):$(dirname "$p")"
done
UNIT_PATH="$(printf '%s' "$LOGIN_PATH:$PATH$EXTRA_DIRS" | tr ':' '\n' | grep -v '^$' | awk '!seen[$0]++' | paste -sd: -)"

UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/$SERVICE.service"
mkdir -p "$UNIT_DIR"
[ -f "$UNIT_FILE" ] && cp "$UNIT_FILE" "$UNIT_FILE.bak" && warn "已备份旧 unit 到 $UNIT_FILE.bak"

{
  cat <<UNIT
[Unit]
Description=CCTower (Claude Code Tower) web workbench
After=network-online.target
Wants=network-online.target
# 崩溃循环保护:60 秒内最多重启 5 次,超限进入 failed(systemctl --user reset-failed 可恢复)
StartLimitBurst=5
StartLimitIntervalSec=60

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=$(command -v node) $DIR/server/index.js
Restart=always
RestartSec=3
TimeoutStopSec=30
# node 收到 SIGTERM 正常退出记 143,视为成功停止
SuccessExitStatus=0 143
# 关键:只结束主进程 node,不牵连 cgroup 里的 tmux server。
# 否则 stop/restart 会连同 tmux 一起杀掉,所有会话丢失——CCTower 靠 tmux 存活跨重启。
KillMode=process
Environment=HOME=$HOME
Environment=TMPDIR=/tmp
# 关键:node-pty 需要带完整 PATH 才能启动 claude / git
Environment=PATH=$UNIT_PATH
Environment=CCW_PORT=$PORT
Environment=CCW_HOST=$HOST
UNIT
  [ -n "$TOKEN" ]         && echo "Environment=CCW_TOKEN=$TOKEN"
  [ -n "$ALLOWED_HOSTS" ] && echo "Environment=CCW_ALLOWED_HOSTS=$ALLOWED_HOSTS"
  [ -n "$BACKEND" ]       && echo "Environment=CCW_BACKEND=$BACKEND"
  cat <<'UNIT'

[Install]
WantedBy=default.target
UNIT
} > "$UNIT_FILE"
chmod 600 "$UNIT_FILE"   # 里面可能有令牌
ok "已写入 $UNIT_FILE"

if [ "$DO_LINGER" = 1 ]; then
  if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" = "yes" ]; then
    ok "linger 已开启(不登录也常驻)"
  elif loginctl enable-linger "$USER" 2>/dev/null; then
    ok "已开启 linger(不登录也常驻、开机自起)"
  elif sudo -n loginctl enable-linger "$USER" 2>/dev/null; then
    ok "已开启 linger(经 sudo)"
  else
    warn "开启 linger 失败 —— 服务会在你退出登录后被停掉。手动执行:sudo loginctl enable-linger $USER"
  fi
fi

systemctl --user daemon-reload
ok "daemon-reload 完成"

# ---------------------------------------------------------------- 6. 启动 + 健康检查
step 6/6 "启动并验证"

if [ "$DO_START" = 0 ]; then
  ok "按 --no-start 要求跳过启动。手动:systemctl --user enable --now $SERVICE"
  exit 0
fi

systemctl --user enable --quiet "$SERVICE" 2>/dev/null || true
systemctl --user restart "$SERVICE"

case "$HOST" in
  0.0.0.0|::|"") PROBE_HOST="127.0.0.1" ;;
  *) PROBE_HOST="$HOST" ;;
esac

CODE=""
for i in $(seq 1 30); do
  CODE="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://$PROBE_HOST:$PORT/" 2>/dev/null || echo 000)"
  [ "$CODE" = "200" ] && break
  systemctl --user is-active --quiet "$SERVICE" || break
  sleep 1
done

if [ "$CODE" != "200" ]; then
  echo
  echo "--- systemctl --user status $SERVICE ---" >&2
  systemctl --user status "$SERVICE" --no-pager -l 2>&1 | head -20 >&2
  echo "--- 最近日志 ---" >&2
  journalctl --user -u "$SERVICE" -n 30 --no-pager 2>&1 >&2
  die "服务没能在 30 秒内响应 http://$PROBE_HOST:$PORT/(拿到 HTTP $CODE)" "上面是 status 与日志。"
fi

ok "HTTP 200 @ http://$PROBE_HOST:$PORT/"
ok "服务 active,PID $(systemctl --user show -p MainPID --value "$SERVICE")"

printf '\n\033[1;32m部署完成\033[0m\n'
cat <<SUMMARY
  目录      $DIR ($BRANCH @ $(git -C "$DIR" rev-parse --short HEAD))
  服务      systemctl --user {status,restart,stop} $SERVICE
  日志      journalctl --user -u $SERVICE -f
  监听      $HOST:$PORT
SUMMARY

if [ "$EXPOSED" = 0 ]; then
  cat <<TIP
  访问      在你的客户端建 SSH 隧道:
              ssh -N -L 7081:127.0.0.1:$PORT $USER@$(hostname -I | awk '{print $1}')
            然后浏览器打开 http://127.0.0.1:7081
TIP
else
  echo "  访问      http://<本机地址>:$PORT  (首次打开会提示输入令牌)"
  if [ "${GENERATED_TOKEN:-0}" = 1 ]; then
    echo
    echo "  令牌(只此一次,记下来):$TOKEN"
  fi
fi
echo
