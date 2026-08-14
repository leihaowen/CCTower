'use strict';
// Mux 是隧道的心脏:开流、半关闭、清理都错不得。
// 这里用一对内存里互联的 Mux 模拟 gateway ↔ agent,不碰真的 WebSocket。
const test = require('node:test');
const assert = require('node:assert');
const { Mux } = require('../shared/tunnel/mux');

// 把两个 Mux 直接对接:一边 send 出去的东西,下一个微任务进另一边的 handleMessage。
// 异步投递(而不是同步直调)才能复现真实网络下"回调不在同一栈"的时序。
function pair() {
  let a, b;
  a = new Mux({ initiator: true, send: (p, bin) => queueMicrotask(() => b.handleMessage(p, bin)) });
  b = new Mux({ initiator: false, send: (p, bin) => queueMicrotask(() => a.handleMessage(p, bin)) });
  return [a, b];
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('开流:对端收到 stream 事件并拿到 meta', async () => {
  const [a, b] = pair();
  const got = new Promise((res) => b.once('stream', res));
  a.open({ type: 'http', path: '/api/health' });
  const s = await got;
  assert.deepEqual(s.meta, { type: 'http', path: '/api/health' });
});

test('双向数据:请求体与响应体各自送达', async () => {
  const [a, b] = pair();
  const serverSide = new Promise((res) => b.once('stream', res));
  const cs = a.open({ type: 'http', path: '/x' });
  const ss = await serverSide;

  const reqChunks = [];
  ss.on('data', (c) => reqChunks.push(c.toString('utf8')));
  cs.write(Buffer.from('hello '));
  cs.write(Buffer.from('body'));
  cs.end();
  await tick();
  assert.equal(reqChunks.join(''), 'hello body');

  const seen = { headers: null, body: '', ended: false };
  cs.on('headers', (m) => { seen.headers = m; });
  cs.on('data', (c) => { seen.body += c.toString('utf8'); });
  cs.on('end', () => { seen.ended = true; });
  ss.headers({ status: 200, headers: { 'content-type': 'application/json' } });
  ss.write(Buffer.from('{"ok":true}'));
  ss.end();
  await tick();
  assert.equal(seen.headers.status, 200);
  assert.equal(seen.body, '{"ok":true}');
  assert.equal(seen.ended, true);
});

test('半关闭:一侧 end 之后另一侧仍能继续发数据', async () => {
  const [a, b] = pair();
  const serverSide = new Promise((res) => b.once('stream', res));
  const cs = a.open({ type: 'ws', path: '/ws/events' });
  const ss = await serverSide;
  cs.end();                       // 客户端说完了
  await tick();
  const late = [];
  cs.on('data', (c) => late.push(c.toString('utf8')));
  ss.write(Buffer.from('还能发'));  // 服务端继续推
  await tick();
  assert.deepEqual(late, ['还能发']);
});

test('两侧都 end 之后流被回收', async () => {
  const [a, b] = pair();
  const serverSide = new Promise((res) => b.once('stream', res));
  const cs = a.open({ type: 'http', path: '/x' });
  const ss = await serverSide;
  cs.end();
  ss.end();
  await tick();
  assert.equal(a.streamCount(), 0);
  assert.equal(b.streamCount(), 0);
});

test('fail 立刻回收两侧并触发 aborted(而不是 error)', async () => {
  const [a, b] = pair();
  const serverSide = new Promise((res) => b.once('stream', res));
  const cs = a.open({ type: 'http', path: '/x' });
  const ss = await serverSide;
  const aborted = new Promise((res) => cs.on('aborted', res));
  ss.fail('本机 CCTower 没起来');
  const err = await aborted;
  assert.match(err.message, /没起来/);
  await tick();
  assert.equal(a.streamCount(), 0);
  assert.equal(b.streamCount(), 0);
});

test('closeAll:所有在途流都收到 aborted 且清空', async () => {
  const [a, b] = pair();
  const s1 = a.open({ type: 'http', path: '/1' });
  const s2 = a.open({ type: 'http', path: '/2' });
  const seen = [];
  s1.on('aborted', () => seen.push(1));
  s2.on('aborted', () => seen.push(2));
  a.closeAll('隧道断了');
  assert.deepEqual(seen.sort(), [1, 2]);
  assert.equal(a.streamCount(), 0);
});

test('ping 自动回 pong,并对外抛事件', async () => {
  const [a, b] = pair();
  const pong = new Promise((res) => a.once('pong', res));
  const ping = new Promise((res) => b.once('ping', res));
  a.sendPing();
  await ping;
  await pong;
});

test('迟到帧与重复 open 都被静默丢弃,不抛异常', () => {
  const [a] = pair();
  const { encodeControl, encodeData } = require('../shared/tunnel/frames');
  a.handleMessage(encodeControl({ streamId: 999, kind: 'end' }), false);      // 已关闭的流
  a.handleMessage(encodeData(999, Buffer.from('x')), true);
  a.handleMessage(encodeControl({ streamId: 12, kind: 'open', meta: {} }), false);
  a.handleMessage(encodeControl({ streamId: 12, kind: 'open', meta: {} }), false); // 重复 open
  assert.equal(a.streamCount(), 1);
});

test('initiator 与非 initiator 的 streamId 不会撞号', () => {
  const [a, b] = pair();
  assert.equal(a.open({}).id % 2, 1);
  assert.equal(b.open({}).id % 2, 0);
});
