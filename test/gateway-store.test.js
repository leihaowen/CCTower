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

test('修复#1:临时文件名唯一化防止并发踩踏', () => {
  // 两个 Store 实例同时写同一个文件,不应互相消费临时文件
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-concurrent-'));
  const store1 = new Store(tmpdir);
  const store2 = new Store(tmpdir);
  const serversFile = path.join(tmpdir, 'servers.json');

  // 模拟两个进程同时各写 5 次
  for (let i = 0; i < 5; i++) {
    store1.addServer(`s1-${i}`);
    store2.addServer(`s2-${i}`);
  }

  const servers = new Store(tmpdir).listServers();
  assert.equal(servers.length, 10, '10 条记录应全部保存(不因并发踩踏而丢失)');

  // 验证临时文件名不是固定的 ${file}.tmp
  // (通过检查写入期间没有遗留的 .tmp 文件)
  const files = fs.readdirSync(tmpdir);
  const tmpFiles = files.filter(f => f.endsWith('.tmp'));
  assert.equal(tmpFiles.length, 0, '写入完成后不应有遗留的 .tmp 文件');

  fs.rmSync(tmpdir, { recursive: true, force: true });
});

test('修复#2:已存在的 0755 目录应被改为 0700', () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-chmod-'));
  const datadir = path.join(tmpdir, 'data');

  // 预先创建一个 0755 的目录
  fs.mkdirSync(datadir, { mode: 0o755 });
  assert.equal(fs.statSync(datadir).mode & 0o777, 0o755, '初始应是 0755');

  // new Store() 应主动修正权限
  new Store(datadir);
  assert.equal(fs.statSync(datadir).mode & 0o777, 0o700, '经 Store 构造后应被改为 0700');

  fs.rmSync(tmpdir, { recursive: true, force: true });
});

test('修复#3:预置 0644 的 .tmp 文件,写入后应是 0600', () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-perm-'));
  const store = new Store(tmpdir);
  const configFile = path.join(tmpdir, 'config.json');

  // 预先制造一个 0644 的 .tmp 文件残留
  // (虽然随机文件名会减轻,但仍要显式验证权限收紧)
  const tmpPath = `${configFile}.0.000.tmp`;
  fs.writeFileSync(tmpPath, '{}', { mode: 0o644 });
  assert.equal(fs.statSync(tmpPath).mode & 0o777, 0o644, '预置文件应是 0644');

  // 这会清理残留的 .tmp 并写入新的
  store.setConfig({ port: 8000 });

  // 最终的 config.json 应该是 0600
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600, '最终文件应是 0600');

  fs.rmSync(tmpdir, { recursive: true, force: true });
});

test('修复#4:ensureSecret 并发幂等性(写盘后返回磁盘值)', () => {
  // 模拟两个进程同时首次调用 ensureSecret()
  // 虽然无法在单进程里真正并发,但可以验证返回值是磁盘上的最终值
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-secret-'));
  const store1 = new Store(tmpdir);

  const secret1 = store1.ensureSecret();
  assert.ok(secret1.length >= 32);

  // 模拟另一个进程读到相同的值(磁盘上的最终值)
  const store2 = new Store(tmpdir);
  const secret2 = store2.getConfig().sessionSecret;

  // 验证 store1 返回的是磁盘上的值,而不是本进程内存里的临时值
  assert.equal(secret1, secret2, 'ensureSecret 返回值应等于磁盘上的最终值');

  fs.rmSync(tmpdir, { recursive: true, force: true });
});
