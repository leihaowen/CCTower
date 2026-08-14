#!/usr/bin/env bash
# 在一台已经跑着 CCTower 的服务器上安装 agent。
# 用法:sudo ./install.sh wss://cc.example.com/tunnel <token> [本机CCTower端口]
set -euo pipefail

GATEWAY_URL="${1:-}"
TOKEN="${2:-}"
LOCAL_PORT="${3:-7080}"
# 布局:/opt/cctower-agent/{app,shared}——两者都在专属命名空间下,不会碰到系统上
# 任何既有的通用路径(比如运维自己用的 /opt/shared)。app/ 与 shared/ 相对关系跟仓库
# 里 agent/ 与 shared/ 一致,agent 的 require('../shared/...') 不用改。
BASE=/opt/cctower-agent
DEST="$BASE/app"
SHARED="$BASE/shared"
CONFIG=/etc/cctower-agent.json
AGENT_USER=cctower-agent

if [ -z "$GATEWAY_URL" ] || [ -z "$TOKEN" ]; then
  echo "用法:sudo $0 wss://网关域名/tunnel <token> [本机CCTower端口]" >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "需要 root(要写 /etc 与 systemd 单元)" >&2
  exit 1
fi
command -v node >/dev/null || { echo "没找到 node,请先安装 Node.js 20+" >&2; exit 1; }

SRC="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$DEST"
# 锁文件已进仓库,拷过去用 npm ci 精确复现版本,而不是每次 npm install 自由解析
cp -r "$SRC/index.js" "$SRC/src" "$SRC/package.json" "$SRC/package-lock.json" "$DEST/"
# 只清理自己命名空间下的 shared/,绝不动 $BASE 之外的任何路径
rm -rf "$SHARED"
cp -r "$SRC/../shared" "$SHARED"
( cd "$DEST" && npm ci --omit=dev --no-audit --no-fund )

# 专用系统用户:agent 只需要出站网络、回环访问与读一个 0600 配置文件,不该以 root
# 身份常驻——它是 systemd Restart=always 拉起的进程,又是网关被攻破后能碰到的
# 唯一枢轴点,root 身份会把爆炸半径从"这台机器的普通账号"扩大到整机。
if ! id -u "$AGENT_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$AGENT_USER"
fi

umask 077
# 重跑本脚本(比如改端口)不该把运维手动填过的 localToken 静默清空,先读旧值再写回。
EXISTING_LOCAL_TOKEN=""
if [ -f "$CONFIG" ]; then
  EXISTING_LOCAL_TOKEN="$(node -e "
    try {
      const c = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
      process.stdout.write(String(c.localToken || ''));
    } catch { /* 旧文件读不出来就当没有,不阻塞安装 */ }
  " "$CONFIG")"
fi
node -e "
  const fs = require('fs');
  const [gatewayUrl, token, localPort, localToken, file] = process.argv.slice(1);
  const cfg = { gatewayUrl, token, localPort: Number(localPort), localToken };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
" "$GATEWAY_URL" "$TOKEN" "$LOCAL_PORT" "$EXISTING_LOCAL_TOKEN" "$CONFIG"
chmod 600 "$CONFIG"
# 配置文件含接入 token,属主必须是实际跑服务的账号,否则以 cctower-agent 身份
# 启动后自己都读不了自己的 0600 配置
chown "$AGENT_USER:$AGENT_USER" "$CONFIG"

install -m 644 "$SRC/../deploy/cctower-agent.service" /etc/systemd/system/cctower-agent.service
systemctl daemon-reload
systemctl enable --now cctower-agent
echo "装好了。看状态:systemctl status cctower-agent"
echo "如果本机 CCTower 设了 CCW_TOKEN,把同样的值填进 $CONFIG 的 localToken 后重启服务。"
