'use strict';
// 全链路:浏览器 → 网关 → 隧道 → agent → 真 CCTower。
// 单元测试能证明每块零件对,只有这条链路能证明它们装在一起还对。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { Store } = require('../gateway/src/store');
const { Hub } = require('../gateway/src/hub');
const { createApp } = require('../gateway/src/app');
const { hashPassword } = require('../gateway/src/auth');
const { createAgent } = require('../agent/index');

const ROOT = path.join(__dirname, '..');
// 避开桌面壳 E2E 的 18977 与桌面壳隧道端口池 17080–17999
const CCW_PORT = 18980;
const PASSWORD = '端到端测试密码';

async function waitHttp(url, ms = 30000) {
  const t0 = Date.now();
  let lastErr = '';
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch (e) { lastErr = e.message; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`起不来(等了 ${ms}ms,${url}${lastErr ? ',最后错误:' + lastErr : ''})`);
}

async function waitUntil(fn, ms = 15000, label = '条件') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`等待${label}超时`);
}

test('端到端:登录 → 总览 → 代理 API → WS → 掉线 → 自愈', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-e2e-data-'));
  const gwDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-e2e-'));

  // 1) 真 CCTower
  const ccw = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, CCW_PORT: String(CCW_PORT), CCW_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ccw.stdout.on('data', () => {});
  ccw.stderr.on('data', () => {});

  // 2) 网关
  const store = new Store(gwDir);
  store.setConfig({ passwordHash: hashPassword(PASSWORD) });
  const { server: reg, token } = store.addServer('e2e-server');
  const hub = new Hub({ store, autoSweep: false });
  const { app, handleUpgrade } = createApp({ store, hub, secureCookie: false });
  const gwServer = http.createServer(app);
  gwServer.on('upgrade', handleUpgrade);
  await new Promise((r) => gwServer.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${gwServer.address().port}`;

  // 3) agent
  let agent = createAgent(
    { gatewayUrl: `${base.replace('http://', 'ws://')}/tunnel`, token, localPort: CCW_PORT, localToken: '' },
    { log: () => {}, backoff: { base: 100, cap: 300 } },
  );

  t.after(async () => {
    agent.stop();
    hub.close();
    gwServer.close();
    ccw.kill('SIGTERM');
    await new Promise((resolve) => {
      if (ccw.exitCode !== null || ccw.signalCode !== null) return resolve();
      const timer = setTimeout(() => { ccw.kill('SIGKILL'); resolve(); }, 5000);
      ccw.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    // 服务端优雅退出时还会落盘,等它真退出再删,否则会撞 ENOTEMPTY
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(gwDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  await waitHttp(`http://127.0.0.1:${CCW_PORT}/`);
  agent.start();
  await waitUntil(() => hub.isOnline(reg.id), 15000, 'agent 上线');

  // 登录
  const loginRes = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(loginRes.status, 200);
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];

  // 总览:在线,且事件订阅已就绪(stale 为 false)
  await waitUntil(async () => {
    const { servers } = await (await fetch(`${base}/api/overview`, { headers: { cookie } })).json();
    return servers[0].online && servers[0].stale === false;
  }, 15000, '总览显示在线且订阅就绪');

  // 经隧道调真 API
  const health = await fetch(`${base}/s/${reg.id}/api/health`, { headers: { cookie } });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  // 经隧道取页面(验证 index.html 能通过代理送达)
  const page = await fetch(`${base}/s/${reg.id}/`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /CCTower/);

  // 经隧道建 WS,应当收到真服务端推的 snapshot
  const snapshot = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http://', 'ws://')}/s/${reg.id}/ws/events`, { headers: { cookie } });
    ws.on('message', (d) => { resolve(JSON.parse(String(d))); ws.close(); });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('等 snapshot 超时')), 15000);
  });
  assert.equal(snapshot.type, 'snapshot');
  assert.ok(Array.isArray(snapshot.sessions));

  // agent 掉线:代理返回 502,总览转离线
  agent.stop();
  await waitUntil(() => !hub.isOnline(reg.id), 10000, 'agent 掉线');
  const down = await fetch(`${base}/s/${reg.id}/api/health`, { headers: { cookie } });
  assert.equal(down.status, 502);
  assert.match(await down.text(), /离线/);

  // 自愈:重新拉起 agent,链路应当自己恢复
  agent = createAgent(
    { gatewayUrl: `${base.replace('http://', 'ws://')}/tunnel`, token, localPort: CCW_PORT, localToken: '' },
    { log: () => {}, backoff: { base: 100, cap: 300 } },
  );
  agent.start();
  await waitUntil(() => hub.isOnline(reg.id), 15000, 'agent 重连');
  const back = await fetch(`${base}/s/${reg.id}/api/health`, { headers: { cookie } });
  assert.equal(back.status, 200);
});

// 终审 I-4:验证整条真实链路(浏览器 → 网关 → 隧道 → agent → 本机服务)组合起来确实
// 安全——网关会话 cookie 与浏览器伪造的 x-ccw-token 都到不了本机服务,agent 自己配置的
// 本机令牌原样送达。这条测试和上面 gateway-proxy.test.js / agent/test/forward.test.js
// 里各自的调用点测试是互补关系,不是重复:那两条分别钉住"网关真调用了净化函数"与
// "agent 真调用了净化函数"这两个独立的调用点(单独破坏任一层,靠另一层兜底,链路末端
// 观察不到差异——这正是纵深防御的设计意图,也是为什么此处的端到端断言无法单独定位
// 是哪一层出的问题);这条测的是两层协同工作的最终效果,同时也是对"整条转发链路真的
// 接上了"的一次真实回归。
test('头部净化端到端:浏览器 cookie 与伪造的 x-ccw-token 都到不了本机服务(I-4)', async (t) => {
  const gwDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-hdr-e2e-'));
  // HTTP 头值必须是 ByteString(ASCII/Latin1),中文字符会让 http.request() 在
  // 构造请求时同步抛 ERR_INVALID_CHAR——本机令牌只能用 ASCII 表达
  const LOCAL_TOKEN = 'agent-local-token-abc123';

  // 假本机 CCTower:只记录实际收到的请求头
  let seenHeaders = null;
  const localSrv = http.createServer((req, res) => {
    seenHeaders = req.headers;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise((r) => localSrv.listen(0, '127.0.0.1', r));
  const localPort = localSrv.address().port;

  const store = new Store(gwDir);
  store.setConfig({ passwordHash: hashPassword(PASSWORD) });
  const { server: reg, token } = store.addServer('hdr-e2e');
  const hub = new Hub({ store, autoSweep: false });
  const { app, handleUpgrade } = createApp({ store, hub, secureCookie: false });
  const gwServer = http.createServer(app);
  gwServer.on('upgrade', handleUpgrade);
  await new Promise((r) => gwServer.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${gwServer.address().port}`;

  const agent = createAgent(
    { gatewayUrl: `${base.replace('http://', 'ws://')}/tunnel`, token, localPort, localToken: LOCAL_TOKEN },
    { log: () => {}, backoff: { base: 100, cap: 300 } },
  );
  t.after(async () => {
    agent.stop();
    hub.close();
    gwServer.close();
    await new Promise((r) => localSrv.close(r));
    fs.rmSync(gwDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  agent.start();
  await waitUntil(() => hub.isOnline(reg.id), 15000, 'agent 上线');

  const loginRes = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(loginRes.status, 200);
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];

  const r = await fetch(`${base}/s/${reg.id}/anything`, {
    headers: {
      cookie,
      origin: base,
      referer: `${base}/`,
      'x-ccw-token': 'ATTACKER-SUPPLIED',
      'x-business-header': 'keep-me',
    },
  });
  assert.equal(r.status, 200);
  assert.ok(seenHeaders, '请求必须真的送达本机服务');
  assert.equal(seenHeaders.cookie, undefined, '网关会话 cookie 不能落进本机服务');
  assert.notEqual(seenHeaders['x-ccw-token'], 'ATTACKER-SUPPLIED', 'x-ccw-token 不能是浏览器伪造值');
  assert.equal(seenHeaders['x-ccw-token'], LOCAL_TOKEN, '必须是 agent 自己注入的本机令牌');
  assert.equal(seenHeaders.origin, undefined);
  assert.equal(seenHeaders.referer, undefined);
  assert.equal(seenHeaders['x-business-header'], 'keep-me', '业务头应该保留');
});

test('安全回归:未登录拿不到任何被代理的内容', async (t) => {
  const gwDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-sec-'));
  const store = new Store(gwDir);
  store.setConfig({ passwordHash: hashPassword(PASSWORD) });
  const { server: reg, token } = store.addServer('sec');
  const hub = new Hub({ store, autoSweep: false });
  const { app, handleUpgrade } = createApp({ store, hub, secureCookie: false });
  const gwServer = http.createServer(app);
  gwServer.on('upgrade', handleUpgrade);
  await new Promise((r) => gwServer.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${gwServer.address().port}`;
  t.after(() => { hub.close(); gwServer.close(); fs.rmSync(gwDir, { recursive: true, force: true }); });

  // 未登录:代理路径 302 去登录页,不泄露任何内容
  const r = await fetch(`${base}/s/${reg.id}/api/health`, { redirect: 'manual' });
  assert.equal(r.status, 302);

  // 被吊销的 token 立刻连不上
  store.removeServer(reg.id);
  const denied = await new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace('http://', 'ws://')}/tunnel`, { headers: { Authorization: `Bearer ${token}` } });
    ws.on('open', () => { ws.close(); resolve(false); });
    ws.on('error', () => resolve(true));
    ws.on('unexpected-response', () => resolve(true));
  });
  assert.equal(denied, true, '删除服务器即吊销 token');
});
