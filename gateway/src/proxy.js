'use strict';
const { packWsMessage, unpackWsMessage } = require('../../shared/tunnel/frames');
const { SESSION_COOKIE } = require('./auth');

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
// cookie 是网关自己的会话凭据,不能带去被代理的机器;host/origin 由 agent 重写;
// x-ccw-token 只能由 agent 注入,浏览器不许自带。
const DROP = new Set(['cookie', 'host', 'origin', 'referer', 'x-ccw-token', ...HOP_BY_HOP]);

function sanitizeRequestHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = String(k).toLowerCase();
    if (DROP.has(key)) continue;
    out[key] = v;
  }
  return out;
}

function offlinePage(name) {
  const safe = String(name || '该服务器').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><meta charset="utf-8"><title>服务器离线</title>
<div style="font:16px/1.7 system-ui;padding:48px;max-width:520px;margin:auto;color:#ddd;background:#15171c">
<h2 style="color:#f0a">服务器离线</h2>
<p>${safe} 当前没有连上网关。它上面的 agent 会自动重连,通常几十秒内恢复。</p>
<p><a href="/" style="color:#6cf">返回总览</a></p></div>`;
}

function proxyHttp(hub, serverId, req, res, targetPath) {
  const stream = hub.open(serverId, {
    type: 'http',
    method: req.method,
    path: targetPath || '/',
    headers: sanitizeRequestHeaders(req.headers),
  });
  if (!stream) {
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
    res.end(offlinePage(serverId));
    return;
  }

  let headersSent = false;
  stream.on('headers', (meta) => {
    const headers = {};
    for (const [k, v] of Object.entries((meta && meta.headers) || {})) {
      const key = String(k).toLowerCase();
      if (HOP_BY_HOP.has(key)) continue;
      if (key === 'set-cookie') {
        // 被代理的机器与网关共用同一个 origin(见规格 §7 的"origin 隔离"取舍),
        // 一台被攻陷的机器可以在响应里夹带一个与网关会话同名的 Set-Cookie,
        // 覆盖用户当前的登录会话(伪造成攻击者已知的值,持续把人踢下线或劫持登录态)。
        // 网关自己的会话 cookie 只能由网关自己签发,这里把同名的 cookie 过滤掉,
        // 其余业务 cookie 原样保留。
        const arr = (Array.isArray(v) ? v : [v]).filter(
          (c) => !String(c).startsWith(`${SESSION_COOKIE}=`),
        );
        if (arr.length) headers[k] = arr;
        continue;
      }
      headers[k] = v;
    }
    try {
      res.writeHead((meta && meta.status) || 200, headers);
      headersSent = true;
    } catch (e) {
      // 响应头本身是外部输入(来自被代理机器的 agent),畸形值(如带 CRLF 的头)会让
      // writeHead 同步抛异常;这一层若不兜住,异常会顺着帧处理一路冒出去被 hub.js
      // 的帧级 try/catch 吞掉——浏览器请求会永久挂起,不报错也不超时。必须在这里
      // 明确回 502 并中止这条流,而不是让异常悄悄消失。
      try {
        res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
        res.end(offlinePage(serverId));
      } catch { /* 连 502 都发不出去,连接大概率已经坏了,交给下面 fail() 中止流 */ }
      stream.fail(`响应头非法:${e.message}`);
    }
  });
  stream.on('data', (chunk) => res.write(chunk));
  stream.on('end', () => res.end());
  stream.on('aborted', () => {
    // 还没发响应头就出事,才有机会告诉用户为什么;已经开始流式回传就只能截断
    if (!headersSent) {
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      res.end(offlinePage(serverId));
    } else {
      res.end();
    }
  });

  req.on('data', (c) => stream.write(c));
  req.on('end', () => stream.end());
  req.on('aborted', () => stream.fail('浏览器断开'));
  res.on('close', () => { if (!res.writableEnded) stream.fail('浏览器断开'); });
}

function bridgeWebSocket(hub, serverId, ws, targetPath) {
  const stream = hub.open(serverId, { type: 'ws', path: targetPath || '/' });
  if (!stream) {
    try { ws.close(1011, '服务器离线'); } catch { /* 已关 */ }
    return;
  }
  ws.on('message', (data, isBinary) => stream.write(packWsMessage(data, isBinary)));
  ws.on('close', () => stream.end());
  ws.on('error', () => stream.fail('浏览器 WS 出错'));
  stream.on('data', (buf) => {
    let m;
    try { m = unpackWsMessage(buf); } catch { return; }
    if (ws.readyState === 1) ws.send(m.data, { binary: m.isBinary });
  });
  stream.on('end', () => { try { ws.close(); } catch { /* 已关 */ } });
  stream.on('aborted', () => { try { ws.close(1011, '隧道中断'); } catch { /* 已关 */ } });
}

module.exports = { proxyHttp, bridgeWebSocket, sanitizeRequestHeaders, offlinePage };
