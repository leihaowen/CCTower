#!/usr/bin/env bash
# 从「有代码的机器」一键部署到远程主机 —— 不依赖目标机能不能访问 GitHub。
#
# 做法:把本地仓库打成 git bundle,经 SSH 送到目标机,再在目标机上跑 deploy/install.sh。
#
# 用法:
#   deploy/remote-install.sh <ssh目标> [--ref REF] [install.sh 的选项...]
#
# 例:
#   deploy/remote-install.sh nimo@192.168.1.143
#   deploy/remote-install.sh nimo@192.168.1.143 --ref origin/main --port 7080
#   deploy/remote-install.sh myserver --host 0.0.0.0 --gen-token --allowed-hosts 192.168.1.143:7080
#
# 选项:
#   --ref REF     要部署的本地 ref(默认 origin/main;没有 origin/main 时回退 HEAD)
#   其余选项原样透传给目标机上的 install.sh(--dir/--port/--host/--token/… 见该脚本 --help)
set -euo pipefail

die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }

[ $# -ge 1 ] || die "缺少 ssh 目标。用法:deploy/remote-install.sh <user@host> [选项...]"
TARGET="$1"; shift

REF=""
BRANCH="main"
PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --ref)    REF="$2"; shift 2 ;;
    --branch) BRANCH="$2"; PASS+=("--branch" "$2"); shift 2 ;;
    *)        PASS+=("$1"); shift ;;
  esac
done

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "当前目录不是 git 仓库"
cd "$REPO_ROOT"
INSTALL_SH="$REPO_ROOT/deploy/install.sh"
[ -f "$INSTALL_SH" ] || die "找不到 $INSTALL_SH"

if [ -z "$REF" ]; then
  if git rev-parse --verify --quiet "origin/$BRANCH" >/dev/null; then REF="origin/$BRANCH"; else REF="HEAD"; fi
fi
git rev-parse --verify --quiet "$REF" >/dev/null || die "本地找不到 ref:$REF"
SHA="$(git rev-parse --short "$REF")"

step "检查 SSH 连通性:$TARGET"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$TARGET" true \
  || die "连不上 $TARGET(需要免密 SSH)。先手动 ssh $TARGET 确认一次。"

step "打包 $REF ($SHA) 为 git bundle"
BUNDLE_LOCAL="$(mktemp -t ccw-XXXXXX.bundle)"
trap 'rm -f "$BUNDLE_LOCAL"' EXIT
# bundle 里的 ref 名就是这里给的 rev 名字;install.sh 用 --bundle-ref 按名取,再改写成目标分支。
git bundle create "$BUNDLE_LOCAL" "$REF" >/dev/null 2>&1 || die "git bundle create 失败"
BUNDLE_REF="$(git bundle list-heads "$BUNDLE_LOCAL" | head -1 | awk '{print $2}')"
[ -n "$BUNDLE_REF" ] || die "bundle 里没有可用的 ref"
printf '   %s → %s (%s)\n' "$BUNDLE_REF" "$(du -h "$BUNDLE_LOCAL" | cut -f1)" "$SHA"

step "传输到 $TARGET"
BUNDLE_REMOTE="/tmp/ccw-deploy-$SHA.bundle"
INSTALL_REMOTE="/tmp/ccw-deploy-$SHA-install.sh"
scp -q -o BatchMode=yes "$BUNDLE_LOCAL" "$TARGET:$BUNDLE_REMOTE" || die "scp 失败"
# 脚本也先送过去再执行,而不是 `bash -s < install.sh`:走 stdin 时,任何读 stdin 的子进程
# (登录 shell 的 profile、npm 脚本……)都会把剩下的脚本内容吞掉,导致执行到一半莫名结束。
scp -q -o BatchMode=yes "$INSTALL_SH" "$TARGET:$INSTALL_REMOTE" || die "scp 失败"

step "在 $TARGET 上执行 install.sh"
set +e
ssh -o BatchMode=yes -o ServerAliveInterval=15 "$TARGET" \
  "bash '$INSTALL_REMOTE' --bundle '$BUNDLE_REMOTE' --bundle-ref '$BUNDLE_REF' --branch '$BRANCH' $(printf '%q ' "${PASS[@]+"${PASS[@]}"}")"
RC=$?
set -e

ssh -o BatchMode=yes "$TARGET" "rm -f '$BUNDLE_REMOTE' '$INSTALL_REMOTE'" 2>/dev/null || true
[ "$RC" -eq 0 ] || die "远程 install.sh 退出码 $RC(上面有具体原因)"
