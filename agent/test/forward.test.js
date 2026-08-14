'use strict';
// 这一层是"隧道 ↔ 本机 CCTower"的翻译官。用真的 http/ws 服务器做对端,
// 因为头部净化和 text/binary 语义这类问题只有在真实协议栈上才暴露。
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
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

// WS 测试专用收尾:
// 1) 先对 stream 触发 'end',走一遍生产代码本来就有的收尾路径——forward.js 的
//    handleWs 会据此调用 local.close(),这是隧道侧正常结束时代理应有的行为。
// 2) 但 wss.close()/http.Server.close() 只停止接受新连接,不终止已建立的连接;
//    真正保证进程能退出、不把测试挂死的,是下面对 wss.clients 逐个 terminate()——
//    这是不依赖 handleWs 是否正确关闭本机连接的硬兜底(已用变异验证:即便注释掉
//    handleWs 里的 local.close() 调用,靠这个兜底测试依然能在断言全部通过后让进程
//    正常退出)。等一小段时间给正常关闭握手,再强制 terminate,避免网络抖动导致握手
//    迟迟不完成、把测试进程卡住。
function closeWs(stream, wss, srv) {
  return new Promise((resolve) => {
    stream.emit('end');
    setTimeout(() => {
      for (const client of wss.clients) client.terminate();
      wss.close(() => srv.close(() => resolve()));
    }, 50);
  });
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

test('HTTP 转发:请求到达本机,响应状态/头/体原样回传', async (t) => {
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
  // 放进 t.after:即便下面的断言抛出也要收尾。closeAllConnections() 是硬兜底——
  // 不依赖 keep-alive 连接是否已经自然结束,断言中途失败时也能让端口立刻释放、
  // 进程正常退出,而不是像裸的 srv.close() 那样可能要等连接结束才会触发回调。
  t.after(() => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }));
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
});

test('HTTP 转发:本机端口没人监听时 fail 出错,而不是静默挂起', async () => {
  const stream = new FakeStream({ type: 'http', method: 'GET', path: '/', headers: {} });
  handleStream(stream, { localPort: 1, localToken: '' }); // 1 端口必然连不上
  stream.emit('end');
  await stream.waitFor('_failed');
  assert.ok(stream.failure, '必须把失败原因告诉网关');
});

test('WS 转发:双向消息往返且 text/binary 语义不丢', async (t) => {
  const srv = http.createServer();
  const wss = new WebSocketServer({ server: srv, path: '/ws/events' });
  wss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary })); // 回声
    ws.send('欢迎');
  });
  const port = await listen(srv);
  const stream = new FakeStream({ type: 'ws', path: '/ws/events' });
  handleStream(stream, { localPort: port, localToken: '' });
  // 放在 t.after 里:即便下面的断言抛出,也一定会收尾,不留活连接
  t.after(() => closeWs(stream, wss, srv));

  await stream.waitFor('_wrote');
  const first = unpackWsMessage(stream.chunks[0]);
  assert.equal(first.isBinary, false);
  assert.equal(first.data.toString('utf8'), '欢迎');

  stream.emit('data', packWsMessage(Buffer.from([1, 2, 3]), true));
  await stream.waitFor('_wrote');
  const echoed = unpackWsMessage(stream.chunks[stream.chunks.length - 1]);
  assert.equal(echoed.isBinary, true);
  assert.deepEqual(Buffer.from(echoed.data), Buffer.from([1, 2, 3]));
});

test('WS 转发:本机连不上时 fail,连上前到达的消息不丢(排队后补发)', async (t) => {
  const srv = http.createServer();
  const wss = new WebSocketServer({ server: srv, path: '/ws/term/1' });
  const got = [];
  wss.on('connection', (ws) => ws.on('message', (d) => got.push(String(d))));
  const port = await listen(srv);

  const stream = new FakeStream({ type: 'ws', path: '/ws/term/1' });
  handleStream(stream, { localPort: port, localToken: '' });
  // stream 这条真连上了本机,收尾时必须走一遍 handleWs 的关闭路径,否则连接会一直挂着
  t.after(() => closeWs(stream, wss, srv));
  stream.emit('data', packWsMessage(Buffer.from('抢跑的输入'), false)); // 本机 ws 还没 open
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(got, ['抢跑的输入']);

  // dead 连的是端口 1,必然连不上,fail 是同步路径里就会走到的,没有本机 socket 需要收尾
  const dead = new FakeStream({ type: 'ws', path: '/ws/term/1' });
  handleStream(dead, { localPort: 1, localToken: '' });
  await dead.waitFor('_failed');
  assert.ok(dead.failure);
});

test('未知流类型直接 fail', () => {
  const stream = new FakeStream({ type: 'ftp' });
  handleStream(stream, { localPort: 7080, localToken: '' });
  assert.match(stream.failure, /未知流类型/);
});

test('畸形 header(控制字符)只让单条流 fail,不会把 agent 进程打崩', () => {
  // http.request() 在构造 ClientRequest 时会同步校验 header 值,遇到控制字符/CRLF
  // 会同步抛 TypeError,根本不走 req.on('error')。网关经隧道送来的东西本质是外部
  // 输入,agent 常驻在用户机器上被 systemd 拉起,不能因为一条畸形帧就整进程崩溃。
  const stream = new FakeStream({
    type: 'http', method: 'GET', path: '/',
    headers: { 'x-evil': 'line1\r\nline2' },
  });
  assert.doesNotThrow(() => handleStream(stream, { localPort: 7080, localToken: '' }));
  assert.ok(stream.failure, '必须转成 stream.fail() 而不是让异常冒出去');
});

test('WS 排队上限:本机迟迟不完成握手时直接 fail,不无界攒内存', async (t) => {
  // 用一个只 accept 连接、永远不回任何字节的裸 TCP server 模拟"端口通但应用层瘫痪,
  // 迟迟不完成 WS 升级握手"——ws 客户端会一直停在 CONNECTING,open 永远不触发。
  const sockets = [];
  const srv = net.createServer((socket) => { sockets.push(socket); });
  const port = await listen(srv);
  t.after(() => new Promise((r) => {
    for (const s of sockets) s.destroy();
    srv.close(r);
  }));

  const stream = new FakeStream({ type: 'ws', path: '/ws/stuck' });
  // 测试用一个很小的上限,不必真攒到生产环境的 1MiB 默认值才能触发
  handleStream(stream, { localPort: port, localToken: '', maxPendingBytes: 64 });

  const chunk = Buffer.alloc(40, 1);
  stream.emit('data', packWsMessage(chunk, true));
  // 超限判定是同步发生的:第二个 emit 里 fail() 会同步触发 '_failed'。必须在这条
  // emit 之前先订阅,否则 once() 会错过一个已经同步发生过的事件,白等到超时。
  const failed = stream.waitFor('_failed');
  stream.emit('data', packWsMessage(chunk, true)); // 累计 80 字节,超过 64 字节上限

  await Promise.race([
    failed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('超时:排队超限没有触发 fail')), 2000)),
  ]);
  assert.match(stream.failure, /上限|排队/);
});
