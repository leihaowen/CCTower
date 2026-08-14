'use strict';
// 暴露面校验:只绑回环可以不设令牌,一旦对外(非回环监听或配了反代域名)就必须有令牌,
// 否则任何人都能创建 terminal session 在这台机器上执行任意命令。
const test = require('node:test');
const assert = require('node:assert');

const { auditExposure } = require('../server/authGuard');

test('只绑回环且无令牌:放行(本机自用的默认形态)', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.0.0.5']) {
    const r = auditExposure({ host, allowedHosts: '', token: '' });
    assert.equal(r.fatal, null, `${host} 应被视为回环`);
    assert.equal(r.warn, null);
  }
});

test('监听非回环地址且无令牌:致命错误,拒绝启动', () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.5']) {
    const r = auditExposure({ host, allowedHosts: '', token: '' });
    assert.ok(r.fatal, `${host} 无令牌应被拦下`);
    assert.match(r.fatal, /CCW_TOKEN/); // 提示必须包含要设的变量名
  }
});

test('配了 CCW_ALLOWED_HOSTS(反向代理域名)且无令牌:即使绑回环也拒绝启动', () => {
  const r = auditExposure({ host: '127.0.0.1', allowedHosts: 'ccw.example.com', token: '' });
  assert.ok(r.fatal);
  assert.match(r.fatal, /CCW_TOKEN/);
});

test('对外但有强令牌:放行且不告警', () => {
  const r = auditExposure({ host: '0.0.0.0', allowedHosts: '', token: 'a'.repeat(24) });
  assert.equal(r.fatal, null);
  assert.equal(r.warn, null);
});

test('对外但令牌过短:放行并告警(不阻断已有部署)', () => {
  const r = auditExposure({ host: '0.0.0.0', allowedHosts: '', token: 'short' });
  assert.equal(r.fatal, null);
  assert.ok(r.warn);
  assert.match(r.warn, /16/); // 告警里点明期望长度
});

test('回环 + 短令牌:不告警(本机自用不对外,长度无意义)', () => {
  const r = auditExposure({ host: '127.0.0.1', allowedHosts: '', token: 'short' });
  assert.equal(r.fatal, null);
  assert.equal(r.warn, null);
});

test('CCW_ALLOWED_HOSTS 只有空白/逗号时不算对外', () => {
  const r = auditExposure({ host: '127.0.0.1', allowedHosts: ' , ', token: '' });
  assert.equal(r.fatal, null);
});

// 上面测的是判定逻辑,这里测"真的会拒绝启动"——保护用户的是接线,不是纯函数。
test('server/index.js 在对外且无令牌时退出非 0 并说明原因', async () => {
  const { spawn } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-guard-'));
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, CCW_HOST: '0.0.0.0', CCW_PORT: '0', CCW_TOKEN: '', CCW_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => { p.kill('SIGKILL'); resolve('timeout:服务没有退出,说明校验没接上'); }, 5000);
    p.on('exit', (c) => { clearTimeout(t); resolve(c); });
  });
  fs.rmSync(dataDir, { recursive: true, force: true });
  assert.equal(code, 1, `期望 exit 1,实际 ${code};输出:${out.slice(0, 300)}`);
  assert.match(out, /CCW_TOKEN/);
});

// 令牌比较:必须常数时间,且长度/编码不匹配时是"不通过"而非抛异常
// (抛异常会被 express 变成 500,而不是 401,且让人以为服务坏了)
test('tokenMatches:正确放行,错误拒绝,多字节与空值不抛异常', () => {
  const { tokenMatches } = require('../server/authGuard');
  assert.equal(tokenMatches('abc123', 'abc123'), true);
  assert.equal(tokenMatches('abc124', 'abc123'), false);
  assert.equal(tokenMatches('', 'abc123'), false);
  assert.equal(tokenMatches('abc123', ''), false);
  assert.equal(tokenMatches(undefined, 'abc123'), false);
  // 字符串长度相同但字节长度不同:不能抛 RangeError
  assert.equal(tokenMatches('中中', 'ab'), false);
  assert.equal(tokenMatches('令牌令牌令牌', '令牌令牌令牌'), true);
});

test('server/index.js 在只绑回环且无令牌时正常启动', async () => {
  const { spawn } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-guard-ok-'));
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, CCW_HOST: '127.0.0.1', CCW_PORT: '0', CCW_TOKEN: '', CCW_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  const started = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 5000);
    p.stdout.on('data', () => { if (/已启动/.test(out)) { clearTimeout(t); resolve(true); } });
    p.on('exit', () => { clearTimeout(t); resolve(false); });
  });
  p.kill('SIGKILL');
  fs.rmSync(dataDir, { recursive: true, force: true });
  assert.ok(started, `本机自用形态不应被拦下;输出:${out.slice(0, 300)}`);
});

test('isLoopbackHostHeader:任意端口的回环 Host 都放行', () => {
  const { isLoopbackHostHeader } = require('../server/authGuard');
  for (const h of ['127.0.0.1:17081', '127.0.0.1:7080', 'localhost:17999', 'localhost',
    '[::1]:7080', 'tauri.localhost', '127.255.0.1:80']) {
    assert.equal(isLoopbackHostHeader(h), true, h);
  }
});

test('isLoopbackHostHeader:非回环一律拒绝', () => {
  const { isLoopbackHostHeader } = require('../server/authGuard');
  for (const h of ['192.168.1.5:7080', 'evil.com', 'evil.com:7080', '127.0.0.1.evil.com',
    'localhost.evil.com', '', null, undefined, '0.0.0.0:7080', '[::]:7080']) {
    assert.equal(isLoopbackHostHeader(h), false, String(h));
  }
});
