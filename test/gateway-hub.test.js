'use strict';
// Hub 管着"哪台服务器现在能用"。掉线、重连、被顶替这些事天天发生,
// 每一种都必须让总览立刻说实话。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Store } = require('../gateway/src/store');
const { Hub } = require('../gateway/src/hub');
const { Mux } = require('../shared/tunnel/mux');
const { packWsMessage } = require('../shared/tunnel/frames');

// 内存里互联的一对假 ws:a 发出去的东西异步进 b
function fakePair() {
  const a = new EventEmitter();
  const b = new EventEmitter();
  a.readyState = 1; b.readyState = 1;
  a.send = (d, o) => queueMicrotask(() => b.emit('message', d, !!(o && o.binary)));
  b.send = (d, o) => queueMicrotask(() => a.emit('message', d, !!(o && o.binary)));
  const shut = () => {
    if (a.readyState === 3) return;
    a.readyState = 3; b.readyState = 3;
    queueMicrotask(() => { a.emit('close'); b.emit('close'); });
  };
  a.close = shut; b.close = shut; a.terminate = shut; b.terminate = shut;
  return [a, b];
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-hub-'));
  const store = new Store(dir);
  const { server } = store.addServer('aws1');
  const hub = new Hub({ store, autoSweep: false });
  return { dir, store, server, hub, cleanup: () => { hub.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('未接入时:总览显示离线,open 返回 null', () => {
  const f = fixture();
  const row = f.hub.overview()[0];
  assert.equal(row.online, false);
  assert.equal(row.name, 'aws1');
  assert.equal(f.hub.open(f.server.id, { type: 'http', path: '/' }), null);
  f.cleanup();
});

test('接入后:上线、lastSeenAt 落盘、open 能拿到流', async () => {
  const f = fixture();
  const [gwSide, agentSide] = fakePair();
  const agentMux = new Mux({ send: (p, bin) => agentSide.send(p, { binary: bin }) });
  agentSide.on('message', (d, bin) => agentMux.handleMessage(d, bin));

  f.hub.attach(f.server, gwSide);
  assert.equal(f.hub.isOnline(f.server.id), true);
  assert.ok(f.store.listServers()[0].lastSeenAt, '上线应记录时间');

  const incoming = new Promise((r) => agentMux.once('stream', r));
  const s = f.hub.open(f.server.id, { type: 'http', path: '/api/health' });
  assert.ok(s);
  const remote = await incoming;
  assert.equal(remote.meta.path, '/api/health');
  f.cleanup();
});

test('掉线:总览转离线,在途流收到 aborted', async () => {
  const f = fixture();
  const [gwSide] = fakePair();
  f.hub.attach(f.server, gwSide);
  const s = f.hub.open(f.server.id, { type: 'http', path: '/x' });
  const aborted = new Promise((r) => s.on('aborted', r));
  gwSide.close();
  await aborted;
  await tick();
  assert.equal(f.hub.isOnline(f.server.id), false);
  assert.equal(f.hub.overview()[0].online, false);
  f.cleanup();
});

test('同一服务器重复接入:旧连接被踢,新连接生效', async () => {
  const f = fixture();
  const [old1] = fakePair();
  const [new1] = fakePair();
  let oldClosed = false;
  old1.on('close', () => { oldClosed = true; });
  f.hub.attach(f.server, old1);
  f.hub.attach(f.server, new1);
  await tick();
  assert.equal(oldClosed, true, '旧连接必须被踢掉,否则两条隧道抢同一台机器');
  assert.equal(f.hub.isOnline(f.server.id), true);
  f.cleanup();
});

test('事件订阅:agent 回放 snapshot 后总览出现会话计数', async () => {
  const f = fixture();
  const [gwSide, agentSide] = fakePair();
  const agentMux = new Mux({ send: (p, bin) => agentSide.send(p, { binary: bin }) });
  agentSide.on('message', (d, bin) => agentMux.handleMessage(d, bin));
  // agent 冒充本机 CCTower 的 /ws/events
  agentMux.on('stream', (s) => {
    if (s.meta.path !== '/ws/events') return;
    s.headers({ open: true });
    s.write(packWsMessage(Buffer.from(JSON.stringify({
      type: 'snapshot',
      sessions: [{ id: '1', status: 'needs_decision' }, { id: '2', status: 'executing' }],
    })), false));
  });

  f.hub.attach(f.server, gwSide);
  await tick(30);
  const row = f.hub.overview()[0];
  assert.equal(row.attention, 1);
  assert.deepEqual(row.counts, { needs_decision: 1, executing: 1 });
  assert.equal(row.stale, false, '订阅正常时不应标记数据过期');
  f.cleanup();
});

test('sweep:超时未收到任何帧的隧道被判死并断开', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-hub-'));
  const store = new Store(dir);
  const { server } = store.addServer('s');
  let clock = 1_000_000;
  const hub = new Hub({ store, autoSweep: false, deadAfterMs: 1000, now: () => clock });
  const [gwSide] = fakePair();
  hub.attach(server, gwSide);
  clock += 500;
  hub.sweep();
  assert.equal(hub.isOnline(server.id), true, '还没到超时不该断');
  clock += 2000;
  hub.sweep();
  await tick();
  assert.equal(hub.isOnline(server.id), false);
  hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('被删除的服务器:即使隧道还在也不出现在总览里', async () => {
  const f = fixture();
  const [gwSide] = fakePair();
  f.hub.attach(f.server, gwSide);
  f.store.removeServer(f.server.id);
  assert.deepEqual(f.hub.overview(), []);
  f.cleanup();
});

// 以下两个用例是对 brief 给定 7 例的补充:变异自查发现"掉线不清空计数"
// 与"事件订阅断了不重试"这两种故意写错的实现,brief 自带的 7 个用例都不会
// FAIL(它们从未在断线后检查 attention/counts,也从未验证重连被安排)。
// 为了让测试真正是回归而不是摆设,这里补两条针对性用例。
test('掉线后旧计数必须清零,不能带着谎言进入下一次总览', async () => {
  const f = fixture();
  const [gwSide, agentSide] = fakePair();
  const agentMux = new Mux({ send: (p, bin) => agentSide.send(p, { binary: bin }) });
  agentSide.on('message', (d, bin) => agentMux.handleMessage(d, bin));
  agentMux.on('stream', (s) => {
    if (s.meta.path !== '/ws/events') return;
    s.headers({ open: true });
    s.write(packWsMessage(Buffer.from(JSON.stringify({
      type: 'snapshot',
      sessions: [{ id: '1', status: 'needs_decision' }],
    })), false));
  });

  f.hub.attach(f.server, gwSide);
  await tick(30);
  assert.equal(f.hub.overview()[0].attention, 1, '前置条件:先有非零计数,否则下面的清零断言没有意义');

  gwSide.close();
  await tick(30);
  assert.equal(f.hub.isOnline(f.server.id), false);
  assert.equal(f.hub.overview()[0].attention, 0, '掉线后 attention 必须清零(dropServer)');
  assert.deepEqual(f.hub.overview()[0].counts, {}, '掉线后 counts 也必须清空');
  f.cleanup();
});

test('事件订阅断线后必须安排重连,不能放任订阅永久失效', async () => {
  const f = fixture();
  const [gwSide, agentSide] = fakePair();
  const agentMux = new Mux({ send: (p, bin) => agentSide.send(p, { binary: bin }) });
  agentSide.on('message', (d, bin) => agentMux.handleMessage(d, bin));
  let remoteStream = null;
  agentMux.on('stream', (s) => {
    if (s.meta.path !== '/ws/events') return;
    remoteStream = s;
    s.headers({ open: true });
  });

  f.hub.attach(f.server, gwSide);
  await tick(30);
  assert.ok(remoteStream, '事件流应已建立');
  assert.equal(f.hub.overview()[0].stale, false);

  remoteStream.fail('模拟对端异常中止'); // 触发网关这侧订阅流的 'aborted'
  await tick(30);

  assert.equal(f.hub.overview()[0].stale, true, '订阅断开应立刻标记 stale');
  const tunnel = f.hub._tunnels.get(f.server.id);
  assert.ok(tunnel && tunnel.retryTimer, '必须安排下一次重连尝试,而不是放任订阅永久失效');
  f.cleanup();
});

// ========== Task 12 新增:removeServer 后隧道立即断开 ==========

test('removeServer 后 sweep 会断开隧道', async () => {
  const f = fixture();
  const [gwSide] = fakePair();
  f.hub.attach(f.server, gwSide);
  assert.equal(f.hub.isOnline(f.server.id), true, 'attach 后应该在线');
  assert.ok(f.hub.open(f.server.id, {}), 'attach 后应该能打开流');

  // 删除服务器(吊销 token)
  f.store.removeServer(f.server.id);

  // 调用一次 sweep,应该自动 detach 已吊销的隧道
  f.hub.sweep();

  // 验证隧道已断开
  assert.equal(f.hub.isOnline(f.server.id), false, 'sweep 后应该离线');
  assert.equal(f.hub.open(f.server.id, {}), null, 'sweep 后不能打开新流');

  f.cleanup();
});

test('存活的服务器在 sweep 中保留', async () => {
  const f = fixture();
  const [gwSide] = fakePair();
  f.hub.attach(f.server, gwSide);

  assert.equal(f.hub.isOnline(f.server.id), true);

  // sweep 时服务器仍在 store 中
  f.hub.sweep();

  // 应该仍然在线
  assert.equal(f.hub.isOnline(f.server.id), true, '未被删除的服务器应该保留');
  assert.ok(f.hub.open(f.server.id, {}), '应该能打开流');

  f.cleanup();
});

test('多服务器情况:只断开已删除的', async () => {
  const f = fixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-hub-multi-'));
  const store = new Store(dir);
  const { server: s1 } = store.addServer('server1');
  const { server: s2 } = store.addServer('server2');

  const hub = new Hub({ store, autoSweep: false });
  const [ws1] = fakePair();
  const [ws2] = fakePair();
  hub.attach(s1, ws1);
  hub.attach(s2, ws2);

  assert.equal(hub.isOnline(s1.id), true);
  assert.equal(hub.isOnline(s2.id), true);

  // 只删除 server1
  store.removeServer(s1.id);
  hub.sweep();

  // server1 应该离线,server2 应该仍在线
  assert.equal(hub.isOnline(s1.id), false);
  assert.equal(hub.isOnline(s2.id), true);

  hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ========== Task 12 修复轮:servers.json 损坏保护 ==========

test('servers.json 损坏时 sweep 不断开在线隧道', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-hub-corrupt-'));
  const store = new Store(dir);
  const { server } = store.addServer('s');

  const hub = new Hub({ store, autoSweep: false });
  const [gwSide] = fakePair();
  hub.attach(server, gwSide);
  assert.equal(hub.isOnline(server.id), true);

  // 破坏 servers.json
  fs.writeFileSync(path.join(dir, 'servers.json'), '{ invalid json');

  // 调用 sweep,应该因为读取失败而跳过吊销检查,保护在线隧道
  hub.sweep();

  // 隧道应该仍然活着(不被误杀)
  assert.equal(hub.isOnline(server.id), true, '坏文件不应该把健康隧道击杀');

  hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('删除最后一个服务器后 sweep 仍然正确断开它的隧道', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-hub-last-'));
  const store = new Store(dir);
  const { server } = store.addServer('last-one');

  const hub = new Hub({ store, autoSweep: false });
  const [gwSide] = fakePair();
  hub.attach(server, gwSide);
  assert.equal(hub.isOnline(server.id), true);

  // 删除唯一的服务器
  store.removeServer(server.id);

  // sweep 应该正确吊销这条隧道(即使服务器名单现在是空的)
  hub.sweep();

  // 隧道应该被断开
  assert.equal(hub.isOnline(server.id), false, '即使最后一个,也应该被吊销');
  assert.equal(hub.overview().length, 0, '总览应该是空的');

  hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
