'use strict';
// 网关 Hub 与服务器删除的交互:token 吊销后隧道必须立即断开
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Store } = require('../gateway/src/store');
const { Hub } = require('../gateway/src/hub');

function mockWs() {
  const emitter = new EventEmitter();
  emitter.readyState = 1; // OPEN
  emitter.send = function(payload, options) { /* 模拟发送 */ };
  emitter.close = function() { this.emit('close'); };
  emitter.terminate = function() { this.emit('close'); };
  return emitter;
}

test('removeServer 后 sweep 会断开隧道', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-hub-'));
  const store = new Store(dir);
  const { server } = store.addServer('test-server');

  // 创建 Hub 并禁用自动 sweep
  const hub = new Hub({ store, autoSweep: false });

  // attach 一条隧道
  const ws = mockWs();
  hub.attach(server, ws);
  assert.equal(hub.isOnline(server.id), true, 'attach 后应该在线');
  assert.ok(hub.open(server.id, {}), 'attach 后应该能打开流');

  // 删除服务器(吊销 token)
  store.removeServer(server.id);

  // 调用一次 sweep,应该自动 detach 已吊销的隧道
  hub.sweep();

  // 验证隧道已断开
  assert.equal(hub.isOnline(server.id), false, 'sweep 后应该离线');
  assert.equal(hub.open(server.id, {}), null, 'sweep 后不能打开新流');

  hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('存活的服务器在 sweep 中保留', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-hub-'));
  const store = new Store(dir);
  const { server } = store.addServer('keep-server');

  const hub = new Hub({ store, autoSweep: false });
  const ws = mockWs();
  hub.attach(server, ws);

  assert.equal(hub.isOnline(server.id), true);

  // sweep 时服务器仍在 store 中
  hub.sweep();

  // 应该仍然在线
  assert.equal(hub.isOnline(server.id), true, '未被删除的服务器应该保留');
  assert.ok(hub.open(server.id, {}), '应该能打开流');

  hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('多服务器情况:只断开已删除的', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-hub-'));
  const store = new Store(dir);
  const { server: s1 } = store.addServer('server1');
  const { server: s2 } = store.addServer('server2');

  const hub = new Hub({ store, autoSweep: false });
  hub.attach(s1, mockWs());
  hub.attach(s2, mockWs());

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
