'use strict';
// CLI 是一期添加服务器的唯一入口,输出必须能直接抄进 agent 配置。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../gateway/src/store');
const { verifyPassword } = require('../gateway/src/auth');
const { run } = require('../gateway/cli');

function ctx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-cli-'));
  const lines = [];
  return {
    dir,
    store: new Store(dir),
    out: (s) => lines.push(String(s)),
    text: () => lines.join('\n'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('add-server:打印 id 与明文 token(仅此一次)', async () => {
  const c = ctx();
  const code = await run(['add-server', 'aws1'], c);
  assert.equal(code, 0);
  const server = c.store.listServers()[0];
  assert.equal(server.name, 'aws1');
  assert.match(c.text(), new RegExp(server.id));
  const m = c.text().match(/token[^\n]*?([A-Za-z0-9_-]{40,})/);
  assert.ok(m, '输出里必须有明文 token');
  assert.equal(c.store.findByToken(m[1]).id, server.id);
  c.cleanup();
});

test('add-server:缺名字时报错且不写入', async () => {
  const c = ctx();
  assert.equal(await run(['add-server'], c), 1);
  assert.deepEqual(c.store.listServers(), []);
  c.cleanup();
});

test('list-servers:列出名字、id 与最后在线时间;空列表有提示', async () => {
  const c = ctx();
  await run(['list-servers'], c);
  assert.match(c.text(), /还没有/);
  const { server } = c.store.addServer('s1');
  await run(['list-servers'], c);
  assert.match(c.text(), new RegExp(server.id));
  assert.match(c.text(), /s1/);
  c.cleanup();
});

test('remove-server:删掉存在的返回 0,不存在的返回 1', async () => {
  const c = ctx();
  const { server } = c.store.addServer('s1');
  assert.equal(await run(['remove-server', server.id], c), 0);
  assert.equal(await run(['remove-server', server.id], c), 1);
  c.cleanup();
});

test('remove-server:输出说明隧道在下一次心跳断开,而非 30 秒', async () => {
  const c = ctx();
  const { server } = c.store.addServer('s1');
  await run(['remove-server', server.id], c);
  const output = c.text();
  assert.match(output, /下一次心跳/);
  assert.match(output, /15\s*秒/); // 期望提到约 15 秒(心跳周期)
  assert.doesNotMatch(output, /30\s*秒/, '不应该错误地承诺 30 秒');
  c.cleanup();
});

test('set-password:写入的是哈希,能被 verifyPassword 验过', async () => {
  const c = ctx();
  const code = await run(['set-password'], { ...c, readPassword: async () => '新密码好长好长密' });
  assert.equal(code, 0);
  const hash = c.store.getConfig().passwordHash;
  assert.match(hash, /^scrypt\$/);
  assert.equal(verifyPassword('新密码好长好长密', hash), true);
  c.cleanup();
});

test('set-password:太短的密码被拒,不写入', async () => {
  const c = ctx();
  assert.equal(await run(['set-password'], { ...c, readPassword: async () => 'abc' }), 1);
  assert.equal(c.store.getConfig().passwordHash, '');
  c.cleanup();
});

test('未知命令与空命令都打印用法并返回 1', async () => {
  const c = ctx();
  assert.equal(await run([], c), 1);
  assert.equal(await run(['nope'], c), 1);
  assert.match(c.text(), /用法/);
  c.cleanup();
});
