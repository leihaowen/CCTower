'use strict';
// 启动前的暴露面校验。
//
// 为什么必须强制:Host / Origin 校验只能防浏览器发起的 CSRF 与 DNS rebinding,
// 挡不住 curl —— Host 头是攻击者可控的,`curl -H 'Host: 127.0.0.1:7080' http://<LAN_IP>:7080/...`
// 能直接穿过白名单。所以一旦服务对外可达,令牌就是唯一的认证边界;缺了它,
// 任何人都能 POST /api/sessions 起一个 terminal session 在这台机器上执行任意命令。

const crypto = require('crypto');

const MIN_TOKEN_LEN = 16;

// 回环判定:只有确定打不到外网的监听地址才算安全。
// 0.0.0.0 / :: 是通配(所有网卡),不是回环。
function isLoopbackHost(host) {
  const h = String(host || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\./.test(h);
}

function hasAllowedHosts(allowedHosts) {
  return String(allowedHosts || '').split(',').some((h) => h.trim());
}

// 返回 { fatal, warn }:fatal 非空则拒绝启动,warn 非空则只打印告警。
function auditExposure({ host, allowedHosts, token } = {}) {
  const exposed = !isLoopbackHost(host) || hasAllowedHosts(allowedHosts);
  if (!exposed) return { fatal: null, warn: null };
  const t = String(token || '');
  if (!t) {
    return {
      fatal: [
        '拒绝启动:服务对外可达但没有设置访问令牌。',
        `  监听地址 CCW_HOST=${host}${hasAllowedHosts(allowedHosts) ? `,额外放行 CCW_ALLOWED_HOSTS=${allowedHosts}` : ''}`,
        '  这样任何能连到本机端口的人都可以创建会话、在这台机器上执行任意命令。',
        '  请设置 CCW_TOKEN 后重启,例如:',
        '    CCW_TOKEN="$(openssl rand -hex 24)" npm start',
        '  只在本机自用则改回 CCW_HOST=127.0.0.1(默认),无需令牌。',
      ].join('\n'),
      warn: null,
    };
  }
  if (t.length < MIN_TOKEN_LEN) {
    return {
      fatal: null,
      warn: `服务对外可达,但 CCW_TOKEN 只有 ${t.length} 个字符,建议至少 ${MIN_TOKEN_LEN} 位随机串(openssl rand -hex 24)。`,
    };
  }
  return { fatal: null, warn: null };
}

// 常数时间比较令牌。先比字节长度再比内容:timingSafeEqual 要求两侧等长,
// 否则抛 RangeError —— 那会被 express 变成 500,让"令牌错"看起来像"服务坏了"。
// 长度本身不是秘密(令牌长度可由部署方公开),提前返回不构成有效侧信道。
function tokenMatches(provided, expected) {
  const a = Buffer.from(String(provided ?? ''), 'utf8');
  const b = Buffer.from(String(expected ?? ''), 'utf8');
  if (b.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Host 头 / Origin host 的回环判定,端口任意。给桌面壳的 SSH 隧道用:
// 隧道本地端口 ≠ 远端端口,Tauri webview 的 Origin 是 tauri://localhost,
// 固定端口白名单两者都会误拒。Host 本就不是网络层认证(见 SECURITY.md),
// 放宽到"任意端口的回环"不改变信任模型。
const LOOPBACK_HEADER_RE = /^(localhost|[a-z0-9-]+\.localhost|127(?:\.\d{1,3}){3}|\[::1\])(:\d{1,5})?$/i;
function isLoopbackHostHeader(host) {
  return LOOPBACK_HEADER_RE.test(String(host || '').trim());
}

module.exports = { auditExposure, isLoopbackHost, tokenMatches, MIN_TOKEN_LEN, isLoopbackHostHeader };
