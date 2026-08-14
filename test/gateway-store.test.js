'use strict';
// 注册表是"谁能接入网关"的唯一真相。这里钉死三件事:
// token 明文不落盘、删除即吊销、写入是原子的(半截文件会让网关重启后失忆)。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, tokenHash } = require('../gateway/src/store');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-store-'));
  return { store: new Store(dir), dir };
}

test('addServer:返回明文 token,但磁盘上只有哈希', () => {
  const { store, dir } = tmpStore();
  const { server, token } = store.addServer('aws1');
  assert.equal(server.name, 'aws1');
  assert.ok(token.length >= 40, 'token 应该足够长');
  assert.equal(server.tokenHash, tokenHash(token));
  const raw = fs.readFileSync(path.join(dir, 'servers.json'), 'utf8');
  assert.ok(!raw.includes(token), '明文 token 绝不能落盘');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('findByToken:命中正确的服务器,错 token 返回 null', () => {
  const { store, dir } = tmpStore();
  const a = store.addServer('a');
  const b = store.addServer('b');
  assert.equal(store.findByToken(a.token).id, a.server.id);
  assert.equal(store.findByToken(b.token).id, b.server.id);
  assert.equal(store.findByToken('wrong'), null);
  assert.equal(store.findByToken(''), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('removeServer:删除即吊销,token 再也认不出来', () => {
  const { store, dir } = tmpStore();
  const { server, token } = store.addServer('gone');
  assert.equal(store.removeServer(server.id), true);
  assert.equal(store.removeServer(server.id), false, '重复删除返回 false');
  assert.equal(store.findByToken(token), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('touch:更新 lastSeenAt 并持久化', () => {
  const { store, dir } = tmpStore();
  const { server } = store.addServer('s');
  assert.equal(server.lastSeenAt, null);
  store.touch(server.id);
  const fresh = new Store(dir).listServers()[0];
  assert.ok(fresh.lastSeenAt, 'lastSeenAt 应写进磁盘');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('配置:默认值可读,setConfig 合并后持久化', () => {
  const { store, dir } = tmpStore();
  assert.equal(store.getConfig().port, 7081);
  store.setConfig({ passwordHash: 'scrypt$x$y' });
  assert.equal(new Store(dir).getConfig().passwordHash, 'scrypt$x$y');
  assert.equal(new Store(dir).getConfig().port, 7081, '未提供的字段保持默认');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ensureSecret:首次生成并落盘,再次调用返回同一个', () => {
  const { store, dir } = tmpStore();
  const s1 = store.ensureSecret();
  assert.ok(s1.length >= 32);
  assert.equal(store.ensureSecret(), s1);
  assert.equal(new Store(dir).ensureSecret(), s1, '重启后会话不应全部失效');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('坏掉的 servers.json 不让网关起不来,按空列表处理', () => {
  const { store, dir } = tmpStore();
  fs.writeFileSync(path.join(dir, 'servers.json'), '{坏文件');
  assert.deepEqual(store.listServers(), []);
  const { server } = store.addServer('recovered'); // 还能继续写
  assert.equal(new Store(dir).listServers()[0].id, server.id);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('数据目录权限为 0700,配置文件为 0600', () => {
  const { store, dir } = tmpStore();
  store.setConfig({ passwordHash: 'x' });
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, 'config.json')).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});
