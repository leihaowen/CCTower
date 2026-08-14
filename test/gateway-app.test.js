'use strict';
// 这层把认证、代理、总览拼在一起。测试用真的 http 服务器 + fetch,
// 因为 cookie、302、101 升级这些行为只有真跑一遍才算数。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Store } = require('../gateway/src/store');
const { Hub } = require('../gateway/src/hub');
const { createApp } = require('../gateway/src/app');
const { hashPassword } = require('../gateway/src/auth');

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-app-'));
  const store = new Store(dir);
  store.setConfig({ passwordHash: hashPassword('好长的密码') });
  const hub = new Hub({ store, autoSweep: false });
  // 测试跑在 http 上,cookie 带 Secure 浏览器会拒收;这里关掉以复现真实会话流程
  const { app, handleUpgrade } = createApp({ store, hub, secureCookie: false });
  const srv = http.createServer(app);
  srv.on('upgrade', handleUpgrade);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return {
    base, store, hub,
    cleanup: () => { hub.close(); srv.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

async function login(base, password = '好长的密码') {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return { status: r.status, cookie };
}

test('未登录:页面 302 去登录页,API 返回 401 JSON', async (t) => {
  const g = await boot();
  t.after(g.cleanup); // 用 t.after 而不是尾部裸调用:断言失败会提前抛出,裸调用会被跳过,留下监听中的 http 服务器让进程挂起
  const page = await fetch(`${g.base}/`, { redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login');
  const api = await fetch(`${g.base}/api/overview`);
  assert.equal(api.status, 401);
  assert.equal((await api.json()).error, 'unauthorized');
});

test('登录页免认证可访问', async (t) => {
  const g = await boot();
  t.after(g.cleanup);
  const r = await fetch(`${g.base}/login`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /密码/);
});

test('登录:密码正确下发 HttpOnly cookie,之后能读总览', async (t) => {
  const g = await boot();
  t.after(g.cleanup);
  g.store.addServer('aws1');
  const { status, cookie } = await login(g.base);
  assert.equal(status, 200);
  assert.match(cookie, /^ccgw_session=/);
  const r = await fetch(`${g.base}/api/overview`, { headers: { cookie } });
  assert.equal(r.status, 200);
  const { servers } = await r.json();
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, 'aws1');
  assert.equal(servers[0].online, false);
});

test('登录:密码错误返回 401,且不下发 cookie', async (t) => {
  const g = await boot();
  t.after(g.cleanup);
  const r = await fetch(`${g.base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: '猜的' }),
  });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('set-cookie'), null);
});

test('登录限速:同一 IP 连续失败第 6 次直接 429', async (t) => {
  const g = await boot();
  t.after(g.cleanup);
  for (let i = 0; i < 5; i++) await login(g.base, '错的');
  const r = await fetch(`${g.base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: '错的' }),
  });
  assert.equal(r.status, 429);
});

test('登录限速:伪造 X-Forwarded-For 前缀改变不了限速计数(只信任最近一跳)', async (t) => {
  const g = await boot();
  t.after(g.cleanup);
  // 真实拓扑里 Caddy 是唯一直连网关的一跳:它会把自己观测到的客户端地址追加到
  // X-Forwarded-For 末尾,攻击者能操纵的只是自己那次请求里已经带的前缀部分。
  // 这里用 "<每次变化的伪造前缀>, 203.0.113.9" 模拟——末位固定,代表 Caddy 追加的
  // 真实来源;trust proxy=1 只信任最近这一跳(即末位),前缀怎么变都不影响限速 key。
  // 注意:若伪造值只有单独一段且没有真实的第二跳(reviewer 描述的字面场景),
  // trust=1 与 trust=true 在这种直连测试里表现完全一样(都会直接采信这唯一一段)——
  // 这不是漏洞,是 X-Forwarded-For 单跳时无法计算,真正体现"只信任最近一跳"这条修复
  // 的场景必须要有至少两段,让"最近一跳"与"攻击者可控前缀"能区分开。
  for (let i = 0; i < 5; i++) {
    await fetch(`${g.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `9.9.9.${i}, 203.0.113.9` },
      body: JSON.stringify({ password: '错的' }),
    });
  }
  const r = await fetch(`${g.base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.99, 203.0.113.9' },
    body: JSON.stringify({ password: '错的' }),
  });
  assert.equal(r.status, 429, '伪造头不能重置限速计数');
});

test('未登录也能取到登录页的样式表,但取不到总览页的脚本', async (t) => {
  const g = await boot();
  t.after(g.cleanup);
  // redirect: 'manual' 是关键:默认 'follow' 会把 302 悄悄带到 /login 再拿到 200,
  // 从而把"其实被拦截了"误判成"能直接拿到"——必须看未跟随重定向前的原始状态码
  const css = await fetch(`${g.base}/gateway.css`, { redirect: 'manual' });
  assert.equal(css.status, 200);
  const js = await fetch(`${g.base}/overview.js`, { redirect: 'manual' });
  assert.equal(js.status, 302, '总览页脚本仍需登录后才能拿到,放行范围不能扩大');
});

test('伪造 cookie 不被接受', async (t) => {
  const g = await boot();
  t.after(g.cleanup);
  // 注意:HTTP 头值必须是 ByteString(ISO-8859-1),fetch/undici 会对非 Latin1 字符直接抛错,
  // 所以伪造值只能用 ASCII 表达"payload.签名不对"这个语义,不能真写中文
  const r = await fetch(`${g.base}/api/overview`, { headers: { cookie: 'ccgw_session=forged.signature' } });
  assert.equal(r.status, 401);
});

test('登出后 cookie 失效', async (t) => {
  const g = await boot();
  t.after(g.cleanup);
  const { cookie } = await login(g.base);
  const out = await fetch(`${g.base}/api/logout`, { method: 'POST', headers: { cookie } });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
});

test('终审 M-8:未登录调用 /api/logout 必须 401,不能被当成强制登出级 CSRF 利用', async (t) => {
  // /api/logout 挂在认证中间件之前时,任何第三方页面都能诱导受害者浏览器打这个接口
  // (跨站 POST,不需要知道 cookie 值,浏览器自动带上),把受害者已登录的会话强制踢下线。
  const g = await boot();
  t.after(g.cleanup);
  const r = await fetch(`${g.base}/api/logout`, { method: 'POST' });
  assert.equal(r.status, 401, '未登录不能调用 /api/logout');
  assert.equal(r.headers.get('set-cookie'), null, '未登录不该收到任何 Set-Cookie(包括清除动作)');
});

test('/s/:id 补尾斜杠;离线服务器代理返回 502', async (t) => {
  const g = await boot();
  t.after(g.cleanup);
  const { server } = g.store.addServer('s1');
  const { cookie } = await login(g.base);
  const r1 = await fetch(`${g.base}/s/${server.id}`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(r1.status, 301);
  assert.equal(r1.headers.get('location'), `/s/${server.id}/`);
  const r2 = await fetch(`${g.base}/s/${server.id}/api/health`, { headers: { cookie } });
  assert.equal(r2.status, 502);
});

test('agent 接入 /tunnel:错 token 被拒,对 token 上线', async (t) => {
  const g = await boot();
  const WebSocket = require('ws');
  const opened = []; // 记录建立成功的连接,收尾时强制 terminate,避免残留句柄挂住进程退出
  t.after(() => { for (const ws of opened) { try { ws.terminate(); } catch { /* 已关 */ } } g.cleanup(); });
  const { server, token } = g.store.addServer('s1');
  const wsUrl = g.base.replace('http://', 'ws://') + '/tunnel';

  const denied = await new Promise((resolve) => {
    // 同上:HTTP 头值必须是 ASCII,这里的"错的"token 只能用 ASCII 乱码表达
    const ws = new WebSocket(wsUrl, { headers: { Authorization: 'Bearer wrong-token' } });
    ws.on('open', () => { opened.push(ws); ws.close(); resolve(false); });
    ws.on('error', () => resolve(true));
    ws.on('unexpected-response', () => resolve(true));
  });
  assert.equal(denied, true, '错 token 必须连不上');

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` } });
    ws.on('open', () => { opened.push(ws); resolve(); });
    ws.on('error', reject);
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(g.hub.isOnline(server.id), true);
});

test('未登录不能升级 /s/:id 的 WebSocket', async (t) => {
  const g = await boot();
  const WebSocket = require('ws');
  const opened = [];
  t.after(() => { for (const ws of opened) { try { ws.terminate(); } catch { /* 已关 */ } } g.cleanup(); });
  const { server } = g.store.addServer('s1');
  const failed = await new Promise((resolve) => {
    const ws = new WebSocket(`${g.base.replace('http://', 'ws://')}/s/${server.id}/ws/events`);
    ws.on('open', () => { opened.push(ws); ws.close(); resolve(false); });
    ws.on('error', () => resolve(true));
    ws.on('unexpected-response', () => resolve(true));
  });
  assert.equal(failed, true);
});
