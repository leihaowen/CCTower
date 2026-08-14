'use strict';
// 主循环的价值全在异常路径:连不上要退避重试、断了要自愈、被 stop 之后必须彻底安静。
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createAgent } = require('../index');

// 可控的假 WebSocket:构造即记录,由测试决定何时 open/close/error
class FakeWS extends EventEmitter {
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.readyState = 0;
    this.sent = [];
    FakeWS.instances.push(this);
  }
  send(data, opts) { this.sent.push({ data, binary: !!(opts && opts.binary) }); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.terminated = true; this.close(); }
  open() { this.readyState = 1; this.emit('open'); }
}
FakeWS.instances = [];

const cfg = { gatewayUrl: 'wss://gw/tunnel', token: 'z'.repeat(32), localPort: 7080, localToken: '' };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('start:用 Bearer token 连接网关', async () => {
  FakeWS.instances = [];
  const a = createAgent(cfg, { WebSocketImpl: FakeWS, log: () => {} });
  a.start();
  assert.equal(FakeWS.instances.length, 1);
  assert.equal(FakeWS.instances[0].url, 'wss://gw/tunnel');
  assert.equal(FakeWS.instances[0].opts.headers.Authorization, `Bearer ${cfg.token}`);
  a.stop();
});

test('断线后按退避重连,重连成功计数归零', async () => {
  FakeWS.instances = [];
  const a = createAgent(cfg, { WebSocketImpl: FakeWS, log: () => {}, backoff: { base: 10, cap: 20 } });
  a.start();
  FakeWS.instances[0].open();
  assert.equal(a.isConnected(), true);
  FakeWS.instances[0].close();
  assert.equal(a.isConnected(), false);
  await tick(40);
  assert.equal(FakeWS.instances.length, 2, '应该自动重连');
  FakeWS.instances[1].open();
  assert.equal(a.isConnected(), true);
  a.stop();
});

test('stop 之后不再重连(避免进程退不掉)', async () => {
  FakeWS.instances = [];
  const a = createAgent(cfg, { WebSocketImpl: FakeWS, log: () => {}, backoff: { base: 10, cap: 20 } });
  a.start();
  a.stop();
  FakeWS.instances[0].close();
  await tick(60);
  assert.equal(FakeWS.instances.length, 1, 'stop 后不该再有新连接');
});

test('心跳:超过 deadAfterMs 没收到任何帧就掐断重连', async () => {
  FakeWS.instances = [];
  const a = createAgent(cfg, { WebSocketImpl: FakeWS, log: () => {}, sweepMs: 10, deadAfterMs: 20, backoff: { base: 10, cap: 20 } });
  a.start();
  FakeWS.instances[0].open();
  await tick(80);
  assert.equal(FakeWS.instances[0].terminated, true, '半死连接必须被掐断');
  a.stop();
});

test('收到 ping 自动回 pong;坏帧不打断隧道', async () => {
  FakeWS.instances = [];
  const { encodeControl } = require('../../shared/tunnel/frames');
  const a = createAgent(cfg, { WebSocketImpl: FakeWS, log: () => {} });
  a.start();
  const ws = FakeWS.instances[0];
  ws.open();
  ws.emit('message', Buffer.from('{坏帧'), false);   // 不该抛
  ws.emit('message', encodeControl({ streamId: 0, kind: 'ping' }), false);
  assert.ok(ws.sent.some((m) => String(m.data).includes('pong')), '必须回 pong');
  a.stop();
});

// 覆盖约定 (c):进程内重启后,旧连接 A 的 close 事件姗姗来迟(网络延迟下的迟到 TCP FIN
// 很常见),不该把已经顶替上去、活得好好的新连接 B 误判为断线。这是 `sock !== ws` 守卫
// 存在的唯一理由——之前 5 条用例里这道守卫恰好总有另一道防线(stopped 标志)兜底,从未被
// 单独测到;这条用例专门把它逼出来。
test('新连接建立后,旧连接姗姗来迟的 close 不该误杀新连接', async () => {
  FakeWS.instances = [];
  const a = createAgent(cfg, { WebSocketImpl: FakeWS, log: () => {}, backoff: { base: 10, cap: 20 } });
  a.start();
  const A = FakeWS.instances[0];
  A.open();
  a.stop();
  a.start();
  const B = FakeWS.instances[1];
  B.open();
  assert.equal(a.isConnected(), true);
  A.emit('close'); // A 的 close 事件姗姗来迟,此时当前连接早已是 B
  assert.equal(a.isConnected(), true, '新连接不该被旧连接的迟到 close 事件误杀');
  assert.equal(FakeWS.instances.length, 2, '不该因为旧连接的迟到 close 多产生一次重连');
  a.stop();
});

// 覆盖修复项 2:不经 stop 连续调两次 start,旧的 sweepTimer 引用会被新的覆盖而漏掉
// clearInterval(定时器泄漏),且会同时存在两条活跃 socket。start() 必须对此免疫。
test('start 不幂等则会重复连接;start() 必须对重复调用免疫', async () => {
  FakeWS.instances = [];
  const a = createAgent(cfg, { WebSocketImpl: FakeWS, log: () => {} });
  a.start();
  a.start(); // 不经 stop 重复调用
  assert.equal(FakeWS.instances.length, 1, '重复 start 不该新建第二条连接');
  a.stop();
});
