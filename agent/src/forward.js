'use strict';
const http = require('node:http');
const WebSocket = require('ws');
const { packWsMessage, unpackWsMessage } = require('../../shared/tunnel/frames');

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
// 这几个头绝不能从浏览器透传进本机 CCTower:
// cookie 是网关的会话凭据(泄露即等于把网关账号交出去),origin/referer 会撞上服务端的
// 同源校验,host 必须改写成回环,x-ccw-token 与 ws 子协议只能由 agent 自己注入。
const DROP_REQUEST = new Set(['cookie', 'origin', 'referer', 'host', 'x-ccw-token', 'sec-websocket-protocol', ...HOP_BY_HOP]);

function localHeaders(headers, { localPort, localToken }) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = String(k).toLowerCase();
    if (DROP_REQUEST.has(key)) continue;
    out[key] = v;
  }
  out.host = `127.0.0.1:${localPort}`;
  if (localToken) out['x-ccw-token'] = localToken;
  return out;
}

// 服务端要求 WS 令牌走子协议(见 server/index.js 的 wsTokenFrom),不进 URL
function wsSubprotocols(localToken) {
  if (!localToken) return [];
  return [`ccw.token.${Buffer.from(String(localToken), 'utf8').toString('base64url')}`];
}

// WS 排队上限:本机握手正常几十毫秒内完成,真要是迟迟等不到 open(本机应用瘫了、
// 端口通但应用层没起来等),继续无脑攒 pending 就是无界内存增长——agent 常驻在用户
// 服务器上被 systemd 拉起,一条卡住的流不该有机会把内存吃穿。1MiB 对正常的终端/表单
// 输入绰绰有余,真超过大概率是本机服务出了问题,不如尽早失败让上层看到。
const DEFAULT_MAX_PENDING_BYTES = 1024 * 1024;

function handleHttp(stream, meta, opts) {
  const req = http.request({
    host: '127.0.0.1',
    port: opts.localPort,
    method: meta.method || 'GET',
    path: meta.path || '/',
    headers: localHeaders(meta.headers, opts),
  }, (res) => {
    const headers = {};
    for (const [k, v] of Object.entries(res.headers)) {
      if (!HOP_BY_HOP.has(String(k).toLowerCase())) headers[k] = v;
    }
    stream.headers({ status: res.statusCode, headers });
    res.on('data', (c) => stream.write(c));
    res.on('end', () => stream.end());
    res.on('error', (e) => stream.fail(e.message));
  });
  req.on('error', (e) => stream.fail(`本机请求失败:${e.message}`));
  stream.on('data', (c) => req.write(c));
  stream.on('end', () => req.end());
  stream.on('aborted', () => req.destroy());
}

function handleWs(stream, meta, opts) {
  const Impl = opts.WebSocketImpl || WebSocket;
  const url = `ws://127.0.0.1:${opts.localPort}${meta.path || '/'}`;
  let local;
  try {
    local = new Impl(url, wsSubprotocols(opts.localToken), { headers: { Host: `127.0.0.1:${opts.localPort}` } });
  } catch (e) {
    stream.fail(`本机 WS 连接失败:${e.message}`);
    return;
  }
  // 浏览器的第一个输入常常比本机握手更快到达,丢了就是"打的字没反应"
  const pending = [];
  const maxPendingBytes = opts.maxPendingBytes || DEFAULT_MAX_PENDING_BYTES;
  let pendingBytes = 0;
  let open = false;
  // fail 只报一次:排队超限主动 terminate() 本机连接后,ws 库自己也会异步吐出一个
  // "WebSocket was closed before the connection was established" 之类的 error 事件,
  // 这个 done 标记保证后到的 error 不会把已经报给网关的、更准确的超限原因覆盖掉。
  let done = false;
  local.on('open', () => {
    open = true;
    stream.headers({ open: true });
    for (const m of pending.splice(0)) local.send(m.data, { binary: m.isBinary });
    pendingBytes = 0;
  });
  local.on('message', (data, isBinary) => stream.write(packWsMessage(data, isBinary)));
  local.on('close', () => stream.end());
  local.on('error', (e) => {
    if (done) return;
    done = true;
    stream.fail(`本机 WS 失败:${e.message}`);
  });
  stream.on('data', (buf) => {
    if (done) return;
    let m;
    try { m = unpackWsMessage(buf); } catch { return; }
    if (open) { local.send(m.data, { binary: m.isBinary }); return; }
    pendingBytes += m.data.length;
    if (pendingBytes > maxPendingBytes) {
      done = true;
      stream.fail(`本机 WS 长时间未完成握手,排队数据超过 ${maxPendingBytes} 字节上限`);
      try { local.terminate(); } catch { /* 已关 */ }
      return;
    }
    pending.push(m);
  });
  stream.on('end', () => { try { local.close(); } catch { /* 已关 */ } });
  stream.on('aborted', () => { try { local.terminate(); } catch { /* 已关 */ } });
}

function handleStream(stream, opts) {
  const meta = stream.meta || {};
  try {
    if (meta.type === 'http') return handleHttp(stream, meta, opts);
    if (meta.type === 'ws') return handleWs(stream, meta, opts);
    return stream.fail(`未知流类型 ${meta.type}`);
  } catch (e) {
    // 畸形 meta(比如 header 里混进控制字符)会让 http.request()/WebSocket 构造函数
    // 同步抛出 TypeError,不会走各自的 on('error') 回调。agent 是常驻进程,被 systemd
    // 拉起来跑在用户的服务器上,一条坏帧就把整个进程打崩(然后反复重启)是不可接受的——
    // 必须兜住,把故障限制在这一条流内,用 fail() 告诉网关,而不是让进程崩溃。
    stream.fail(`处理流失败:${e.message}`);
  }
}

module.exports = { handleStream, localHeaders, wsSubprotocols };
