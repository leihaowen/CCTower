'use strict';
// 网关是唯一暴露在公网的东西,认证这一层错了就全盘皆输。
const test = require('node:test');
const assert = require('node:assert');
const {
  hashPassword, verifyPassword, signSession, verifySession,
  buildCookie, clearCookie, parseCookies, RateLimiter, SESSION_COOKIE,
} = require('../gateway/src/auth');

test('密码:同一密码两次哈希不同(带盐),但都能验过', () => {
  const h1 = hashPassword('correct horse');
  const h2 = hashPassword('correct horse');
  assert.notEqual(h1, h2, '必须加盐');
  assert.equal(verifyPassword('correct horse', h1), true);
  assert.equal(verifyPassword('correct horse', h2), true);
  assert.equal(verifyPassword('wrong', h1), false);
});

test('密码:畸形或空的存储值一律不通过,而不是抛异常', () => {
  for (const bad of ['', null, undefined, 'plain', 'scrypt$only-two', 'bcrypt$a$b', 'scrypt$!!$!!']) {
    assert.equal(verifyPassword('x', bad), false, `${bad} 应判为不通过`);
  }
});

test('会话:签发的令牌能验过并带回过期时间', () => {
  const secret = 'test-secret';
  const exp = Math.floor(Date.now() / 1000) + 60;
  const payload = verifySession(secret, signSession(secret, exp));
  assert.equal(payload.exp, exp);
});

test('会话:改签名、换密钥、过期、垃圾串都验不过', () => {
  const secret = 'test-secret';
  const now = Math.floor(Date.now() / 1000);
  const token = signSession(secret, now + 60);
  assert.equal(verifySession('other-secret', token), null);
  assert.equal(verifySession(secret, token.slice(0, -2) + 'xx'), null);
  assert.equal(verifySession(secret, signSession(secret, now - 1)), null, '过期必须拒绝');
  for (const bad of ['', 'nodot', 'a.b', null]) assert.equal(verifySession(secret, bad), null);
});

test('cookie:默认带 HttpOnly/Secure/SameSite=Lax,清除时 Max-Age=0', () => {
  const c = buildCookie('abc');
  assert.match(c, new RegExp(`^${SESSION_COOKIE}=abc;`));
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Max-Age=604800/);
  assert.match(clearCookie(), /Max-Age=0/);
});

test('cookie:本地 http 调试可关掉 Secure,否则浏览器根本不存', () => {
  assert.ok(!/Secure/.test(buildCookie('abc', { secure: false })));
});

test('parseCookies:多个 cookie、含等号的值、空头都能正确处理', () => {
  assert.deepEqual(parseCookies('a=1; ccgw_session=x.y'), { a: '1', ccgw_session: 'x.y' });
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(undefined), {});
  assert.equal(parseCookies('t=a=b').t, 'a=b');
});

test('限速:同一 key 超过上限被拒,窗口滑过后恢复', () => {
  let clock = 1000;
  const rl = new RateLimiter({ limit: 3, windowMs: 1000, now: () => clock });
  assert.equal(rl.allow('ip'), true);
  assert.equal(rl.allow('ip'), true);
  assert.equal(rl.allow('ip'), true);
  assert.equal(rl.allow('ip'), false, '第 4 次应被拒');
  assert.equal(rl.allow('other'), true, '不同 key 互不影响');
  clock += 1001;
  assert.equal(rl.allow('ip'), true, '窗口滑过后恢复');
});

test('限速:登录成功后 reset,让正常用户不被自己之前的失败拖累', () => {
  let clock = 0;
  const rl = new RateLimiter({ limit: 2, windowMs: 1000, now: () => clock });
  rl.allow('ip'); rl.allow('ip');
  assert.equal(rl.allow('ip'), false);
  rl.reset('ip');
  assert.equal(rl.allow('ip'), true);
});

test('密码:哈希长度不对(salt 合法但摘要错误)拒绝', () => {
  // 构造格式正确但哈希长度错误的存储值:scrypt$<合法salt>$<错误长度hash>
  const validSalt = Buffer.alloc(16).toString('base64');
  const shortHash = Buffer.alloc(16).toString('base64'); // 应该是 32 字节
  const malformed = `scrypt$${validSalt}$${shortHash}`;
  assert.equal(verifyPassword('anything', malformed), false, '哈希长度错误应拒绝');
});

test('cookie:value 含分号/换行/控制字符时抛出中文错误', () => {
  for (const bad of ['a;b', 'a\nb', 'a\rb', 'a\x00b', 'a\x1Fb']) {
    assert.throws(
      () => buildCookie(bad),
      /Cookie 值不能含分号、换行或控制字符/,
      `值 ${JSON.stringify(bad)} 应抛异常`
    );
  }
});

test('限速:大量不同 key 超窗口后被惰性清理', () => {
  let clock = 0;
  const rl = new RateLimiter({ limit: 1, windowMs: 1000, now: () => clock });
  // 塞进 1000 个不同 key,每个各调用一次 allow
  for (let i = 0; i < 1000; i++) {
    rl.allow(`ip_${i}`);
  }
  assert.equal(rl.size(), 1000, '1000 个 key 应全部存在');
  // 时间推进超过一个窗口
  clock += 1001;
  // 再调用一次 allow 触发清理
  rl.allow('trigger');
  assert.ok(rl.size() < 100, `清理后 Map 大小应回落,实际 ${rl.size()}`);
});
