'use strict';
// 这一层是"隧道 ↔ 本机 CCTower"的翻译官。用真的 http/ws 服务器做对端,
// 因为头部净化和 text/binary 语义这类问题只有在真实协议栈上才暴露。
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { WebSocketServer } = require('ws');
const { handleStream, localHeaders, wsSubprotocols } = require('../src/forward');
const { packWsMessage, unpackWsMessage } = require('../../shared/tunnel/frames');

// 冒充 Mux 的 Stream:记录 agent 回传的东西,同时能模拟网关侧的输入
class FakeStream extends EventEmitter {
  constructor(meta) { super(); this.meta = meta; this.sentHeaders = null; this.chunks = []; this.ended = false; this.failure = null; }
  headers(m) { this.sentHeaders = m; }
  write(p) { this.chunks.push(Buffer.from(p)); this.emit('_wrote'); }
  end() { this.ended = true; this.emit('_ended'); }
  fail(m) { this.failure = m; this.emit('_failed'); }
  body() { return Buffer.concat(this.chunks).toString('utf8'); }
  waitFor(evt) { return new Promise((r) => this.once(evt, r)); }
}

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

test('头部净化:cookie/origin/x-ccw-token 被丢弃,host 改写,本机令牌注入', () => {
  const h = localHeaders({
    cookie: 'ccgw_session=secret', origin: 'https://cc.example.com', referer: 'https://cc.example.com/',
    host: 'cc.example.com', 'x-ccw-token': '伪造', connection: 'keep-alive',
    'user-agent': 'test-agent', 'content-type': 'application/json',
  }, { localPort: 7080, localToken: '本机令牌' });
  assert.equal(h.cookie, undefined, '网关会话 cookie 绝不能进本机服务');
  assert.equal(h.origin, undefined);
  assert.equal(h.referer, undefined);
  assert.equal(h.connection, undefined);
  assert.equal(h.host, '127.0.0.1:7080');
  assert.equal(h['x-ccw-token'], '本机令牌', '只认 agent 自己注入的令牌');
  assert.equal(h['user-agent'], 'test-agent', '普通头正常透传');
});

test('没配本机令牌时不注入 x-ccw-token', () => {
  const h = localHeaders({ 'x-ccw-token': '伪造' }, { localPort: 7080, localToken: '' });
  assert.equal(h['x-ccw-token'], undefined);
  assert.deepEqual(wsSubprotocols(''), []);
  assert.deepEqual(wsSubprotocols('abc'), ['ccw.token.' + Buffer.from('abc').toString('base64url')]);
});

test('HTTP 转发:请求到达本机,响应状态/头/体原样回传', async () => {
  let seen = null;
  const srv = http.createServer((req, res) => {
    seen = { method: req.method, url: req.url, headers: req.headers };
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.body = body;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const port = await listen(srv);
  const stream = new FakeStream({ type: 'http', method: 'POST', path: '/api/sessions?x=1', headers: { 'content-type': 'application/json' } });
  handleStream(stream, { localPort: port, localToken: '' });
  stream.emit('data', Buffer.from('{"name":"a"}'));
  stream.emit('end');
  await stream.waitFor('_ended');
  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, '/api/sessions?x=1');
  assert.equal(seen.body, '{"name":"a"}');
  assert.equal(stream.sentHeaders.status, 201);
  assert.equal(stream.sentHeaders.headers['content-type'], 'application/json');
  assert.equal(stream.body(), '{"ok":true}');
  srv.close();
});

test('HTTP 转发:本机端口没人监听时 fail 出错,而不是静默挂起', async () => {
  const stream = new FakeStream({ type: 'http', method: 'GET', path: '/', headers: {} });
  handleStream(stream, { localPort: 1, localToken: '' }); // 1 端口必然连不上
  stream.emit('end');
  await stream.waitFor('_failed');
  assert.ok(stream.failure, '必须把失败原因告诉网关');
});

test('WS 转发:双向消息往返且 text/binary 语义不丢', async () => {
  const srv = http.createServer();
  const wss = new WebSocketServer({ server: srv, path: '/ws/events' });
  wss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary })); // 回声
    ws.send('欢迎');
  });
  const port = await listen(srv);
  const stream = new FakeStream({ type: 'ws', path: '/ws/events' });
  handleStream(stream, { localPort: port, localToken: '' });

  await stream.waitFor('_wrote');
  const first = unpackWsMessage(stream.chunks[0]);
  assert.equal(first.isBinary, false);
  assert.equal(first.data.toString('utf8'), '欢迎');

  stream.emit('data', packWsMessage(Buffer.from([1, 2, 3]), true));
  await stream.waitFor('_wrote');
  const echoed = unpackWsMessage(stream.chunks[stream.chunks.length - 1]);
  assert.equal(echoed.isBinary, true);
  assert.deepEqual(Buffer.from(echoed.data), Buffer.from([1, 2, 3]));

  wss.close(); srv.close();
});

test('WS 转发:本机连不上时 fail,连上前到达的消息不丢(排队后补发)', async () => {
  const srv = http.createServer();
  const wss = new WebSocketServer({ server: srv, path: '/ws/term/1' });
  const got = [];
  wss.on('connection', (ws) => ws.on('message', (d) => got.push(String(d))));
  const port = await listen(srv);

  const stream = new FakeStream({ type: 'ws', path: '/ws/term/1' });
  handleStream(stream, { localPort: port, localToken: '' });
  stream.emit('data', packWsMessage(Buffer.from('抢跑的输入'), false)); // 本机 ws 还没 open
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(got, ['抢跑的输入']);

  const dead = new FakeStream({ type: 'ws', path: '/ws/term/1' });
  handleStream(dead, { localPort: 1, localToken: '' });
  await dead.waitFor('_failed');
  assert.ok(dead.failure);

  wss.close(); srv.close();
});

test('未知流类型直接 fail', () => {
  const stream = new FakeStream({ type: 'ftp' });
  handleStream(stream, { localPort: 7080, localToken: '' });
  assert.match(stream.failure, /未知流类型/);
});
