'use strict';
const { packWsMessage, unpackWsMessage } = require('../../shared/tunnel/frames');

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
    headersSent = true;
    const headers = {};
    for (const [k, v] of Object.entries((meta && meta.headers) || {})) {
      if (!HOP_BY_HOP.has(String(k).toLowerCase())) headers[k] = v;
    }
    res.writeHead((meta && meta.status) || 200, headers);
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
