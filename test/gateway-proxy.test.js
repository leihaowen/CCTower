'use strict';
// 代理层要做到"透明":浏览器感觉不到中间隔着一条隧道。
// 这里用假 Hub 直接对接一个内存 agent,验证请求/响应/离线三条路径。
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { Mux } = require('../shared/tunnel/mux');
const { proxyHttp, bridgeWebSocket, sanitizeRequestHeaders } = require('../gateway/src/proxy');
const { packWsMessage, unpackWsMessage } = require('../shared/tunnel/frames');

// 假 Hub:open() 直接返回一条与"agent 侧 Mux"相连的流
function hubWithAgent(agentHandler) {
  let gw, ag;
  gw = new Mux({ initiator: true, send: (p, b) => queueMicrotask(() => ag.handleMessage(p, b)) });
  ag = new Mux({ initiator: false, send: (p, b) => queueMicrotask(() => gw.handleMessage(p, b)) });
  ag.on('stream', agentHandler);
  return { open: (id, meta) => (id === 'off' ? null : gw.open(meta)) };
}

function listenOnce(handler) {
  const srv = http.createServer(handler);
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}

test('请求头净化:去掉 cookie/host 等,保留业务头', () => {
  const h = sanitizeRequestHeaders({
    cookie: 'ccgw_session=x', host: 'cc.example.com', origin: 'https://cc.example.com',
    connection: 'keep-alive', 'content-type': 'application/json', 'x-ccw-token': '伪造',
  });
  assert.equal(h.cookie, undefined);
  assert.equal(h.host, undefined);
  assert.equal(h.origin, undefined);
  assert.equal(h.connection, undefined);
  assert.equal(h['x-ccw-token'], undefined, '本机令牌只能由 agent 注入');
  assert.equal(h['content-type'], 'application/json');
});

test('HTTP 代理:请求方法/路径/体到达 agent,响应原样回浏览器', async (t) => {
  let seenMeta = null;
  let seenBody = '';
  const hub = hubWithAgent((s) => {
    seenMeta = s.meta;
    s.on('data', (c) => { seenBody += c.toString('utf8'); });
    s.on('end', () => {
      s.headers({ status: 201, headers: { 'content-type': 'application/json' } });
      s.write(Buffer.from('{"id":"abc"}'));
      s.end();
    });
  });

  const { srv, port } = await listenOnce((req, res) => proxyHttp(hub, 'srv1', req, res, req.url));
  // 用 t.after 而不是尾部裸调用 close():断言失败会提前抛出并跳过尾部代码,
  // 裸调用会让监听中的 server 一直挂着,进程再也退不出去(挂起而非快速失败)。
  t.after(() => srv.close());
  const r = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}',
  });
  assert.equal(r.status, 201);
  assert.equal(await r.text(), '{"id":"abc"}');
  assert.equal(seenMeta.method, 'POST');
  assert.equal(seenMeta.path, '/api/sessions');
  assert.equal(seenBody, '{"name":"x"}');
});

test('HTTP 代理:服务器离线返回 502 中文页面', async (t) => {
  const hub = hubWithAgent(() => {});
  const { srv, port } = await listenOnce((req, res) => proxyHttp(hub, 'off', req, res, req.url));
  t.after(() => srv.close());
  const r = await fetch(`http://127.0.0.1:${port}/api/sessions`);
  assert.equal(r.status, 502);
  const text = await r.text();
  assert.match(text, /离线/);
});

test('HTTP 代理:agent 中途报错且尚未发响应头时,回 502 而不是挂死', async (t) => {
  const hub = hubWithAgent((s) => s.on('end', () => s.fail('本机 CCTower 没起来')));
  const { srv, port } = await listenOnce((req, res) => proxyHttp(hub, 'srv1', req, res, req.url));
  t.after(() => srv.close());
  const r = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(r.status, 502);
});

test('WS 桥接:双向消息与 text/binary 语义保持', async () => {
  const hub = hubWithAgent((s) => {
    s.headers({ open: true });
    s.on('data', (buf) => {
      const m = unpackWsMessage(buf);
      s.write(packWsMessage(Buffer.concat([Buffer.from('echo:'), m.data]), m.isBinary));
    });
  });
  const browser = new EventEmitter();
  browser.readyState = 1;
  browser.sent = [];
  browser.send = (d, o) => browser.sent.push({ d, binary: !!(o && o.binary) });
  browser.close = () => { browser.readyState = 3; browser.closed = true; };

  bridgeWebSocket(hub, 'srv1', browser, '/ws/term/1');
  browser.emit('message', Buffer.from('hi'), false);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(browser.sent[0].d.toString('utf8'), 'echo:hi');
  assert.equal(browser.sent[0].binary, false);
});

test('WS 桥接:服务器离线时立刻关掉浏览器连接(不让它空等)', () => {
  const hub = hubWithAgent(() => {});
  const browser = new EventEmitter();
  browser.readyState = 1;
  browser.send = () => {};
  let closeCode = null;
  browser.close = (code) => { closeCode = code; browser.readyState = 3; };
  bridgeWebSocket(hub, 'off', browser, '/ws/events');
  assert.equal(closeCode, 1011);
});
