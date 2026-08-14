#!/usr/bin/env bash
# 在一台已经跑着 CCTower 的服务器上安装 agent。
# 用法:sudo ./install.sh wss://cc.example.com/tunnel <token> [本机CCTower端口]
set -euo pipefail

GATEWAY_URL="${1:-}"
TOKEN="${2:-}"
LOCAL_PORT="${3:-7080}"
DEST=/opt/cctower-agent
CONFIG=/etc/cctower-agent.json

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
cp -r "$SRC/index.js" "$SRC/src" "$SRC/package.json" "$DEST/"
# agent 用 require('../shared/tunnel/mux') 引共享代码,所以 shared/ 必须与 $DEST 同级
rm -rf "$(dirname "$DEST")/shared"
cp -r "$SRC/../shared" "$(dirname "$DEST")/shared"
( cd "$DEST" && npm install --omit=dev --no-audit --no-fund )

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

install -m 644 "$SRC/../deploy/cctower-agent.service" /etc/systemd/system/cctower-agent.service
systemctl daemon-reload
systemctl enable --now cctower-agent
echo "装好了。看状态:systemctl status cctower-agent"
echo "如果本机 CCTower 设了 CCW_TOKEN,把同样的值填进 $CONFIG 的 localToken 后重启服务。"
