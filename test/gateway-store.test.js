'use strict';
// 注册表是"谁能接入网关"的唯一真相。这里钉死三件事:
// token 明文不落盘、删除即吊销、写入是原子的(半截文件会让网关重启后失忆)。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
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

test('修复#1:临时文件名唯一化防止并发踩踏', { timeout: 10000 }, (t, done) => {
  // 真实子进程并发写,验证固定 tmp 名会导致 rename ENOENT 崩溃
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-concurrent-'));
  const storeModulePath = path.join(__dirname, '..', 'gateway', 'src', 'store');

  let exitCount = 0;
  let proc1ExitCode = null;
  let proc2ExitCode = null;
  let proc1Stderr = '';
  let proc2Stderr = '';

  const onExit = () => {
    exitCount++;
    if (exitCount === 2) {
      // 两个子进程都退出后检查结果
      if (proc1ExitCode !== 0) {
        console.error('子进程 1 stderr:', proc1Stderr);
      }
      if (proc2ExitCode !== 0) {
        console.error('子进程 2 stderr:', proc2Stderr);
      }
      assert.equal(proc1ExitCode, 0, '子进程 1 应正常退出(exitCode 0)');
      assert.equal(proc2ExitCode, 0, '子进程 2 应正常退出(exitCode 0)');

      const servers = new Store(tmpdir).listServers();
      // 两个子进程各 50 次,理想应有 100 条,但"读-改-写"之间的毫秒级窗口
      // 可能导致并发更新丢失(已裁定为可接受残留),所以只断言记录存在(非零即可)
      assert.ok(servers.length > 0, `应有记录被保存(实际: ${servers.length})`);

      fs.rmSync(tmpdir, { recursive: true, force: true });
      done();
    }
  };

  // 子进程脚本:各跑 50 次 addServer
  const scriptCode = `
const { Store } = require('${storeModulePath}');
const dir = process.argv[1];
const store = new Store(dir);
for (let i = 0; i < 50; i++) {
  store.addServer('s-' + process.pid + '-' + i);
}
  `.trim();

  // 起两个子进程同时向同一目录写(使用 -e 内联脚本)
  const proc1 = spawn('node', ['-e', scriptCode, tmpdir]);
  proc1.stderr.on('data', (data) => { proc1Stderr += data.toString(); });
  proc1.on('exit', (code) => {
    proc1ExitCode = code;
    onExit();
  });

  const proc2 = spawn('node', ['-e', scriptCode, tmpdir]);
  proc2.stderr.on('data', (data) => { proc2Stderr += data.toString(); });
  proc2.on('exit', (code) => {
    proc2ExitCode = code;
    onExit();
  });
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

test('修复#4:ensureSecret 绝不返回空字符串(防重写覆盖)', () => {
  // setConfig 与 getConfig 之间若另一进程覆盖 config.json(不含 sessionSecret)
  // 重新读盘会拿到空字符串,ensureSecret 必须检测并再写一次
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-secret-'));
  const store = new Store(tmpdir);

  // 用桩函数模拟"磁盘被另一进程清空 sessionSecret"的场景
  // 直接让 getConfig 恒定返回空 sessionSecret(覆盖整个方法,不用调用计数)
  const realGetConfig = store.getConfig.bind(store);
  store.getConfig = () => ({ ...realGetConfig(), sessionSecret: '' });

  try {
    const secret = store.ensureSecret();
    // ensureSecret 应检测到空值并重写,返回的仍是非空且长度合理的密钥
    assert.ok(secret && secret.length >= 32, 'ensureSecret 永不返回空字符串');
  } finally {
    delete store.getConfig;  // 还原成原型上的方法
  }

  fs.rmSync(tmpdir, { recursive: true, force: true });
});
