'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');
const { SessionManager } = require('./manager');

const PORT = Number(process.env.CCW_PORT || 7080);
// PRD §8 安全要求:默认只绑定 localhost。设 CCW_HOST=0.0.0.0 对外时必须配 CCW_TOKEN,
// 且把外部访问域名加入 CCW_ALLOWED_HOSTS(逗号分隔 host:port)。
const HOST = process.env.CCW_HOST || '127.0.0.1';
const BASE = `http://127.0.0.1:${PORT}`; // hooks/report 回调恒走本机回环
const DATA_DIR = process.env.CCW_DATA_DIR || path.join(__dirname, '..', '.ccw-data');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const app = express();
app.use(express.json({ limit: '1mb' }));

// 防御浏览器驱动的 CSRF / DNS rebinding:只接受本机 Host,且 Origin(若有)必须同源。
// 本机 curl(hooks/report)不带 Origin,不受影响。
const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${PORT}`, `localhost:${PORT}`,
  ...(process.env.CCW_ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean),
]);
function isLocalRequest(headers) {
  if (!ALLOWED_HOSTS.has(headers.host)) return false;
  if (headers.origin) {
    try { return ALLOWED_HOSTS.has(new URL(headers.origin).host); } catch { return false; }
  }
  return true;
}
// 可选认证:设置 CCW_TOKEN(或 config.json 的 authToken)后,API 与 WS 都要求令牌。
// WS 经 Sec-WebSocket-Protocol 子协议携带(base64url),绝不放进 URL(避免进代理日志/浏览器历史)。
function wsTokenFrom(req) {
  const raw = req.headers['sec-websocket-protocol'] || '';
  for (const p of raw.split(',').map((x) => x.trim())) {
    if (p.startsWith('ccw.token.')) {
      try { return Buffer.from(p.slice(10), 'base64url').toString('utf8'); } catch { return ''; }
    }
  }
  return '';
}
function authOk(req) {
  if (!AUTH_TOKEN) return true;
  const t = req.headers['x-ccw-token'] || wsTokenFrom(req);
  return t.length === AUTH_TOKEN.length && require('crypto').timingSafeEqual(Buffer.from(t), Buffer.from(AUTH_TOKEN));
}
app.use('/api', (req, res, next) => {
  if (!isLocalRequest(req.headers)) return res.status(403).json({ error: 'forbidden' });
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  next();
});

// ---------- websocket fan-out ----------
const eventClients = new Set();
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of eventClients) if (ws.readyState === 1) ws.send(msg);
}

// ---------- 通知配置(飞书群机器人 webhook)----------
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
let config = { feishuWebhook: '', notifyReviewReady: false, authToken: '' };
try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch { /* 未配置 */ }
const AUTH_TOKEN = process.env.CCW_TOKEN || config.authToken || '';
const saveConfig = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });

const REASON_LABEL = { needs_decision: '需要决策', needs_permission: '需要权限', blocked: '阻塞', review_ready: '完成待审' };
function pushFeishu(text) {
  if (!config.feishuWebhook) return Promise.resolve({ skipped: true });
  return fetch(config.feishuWebhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_type: 'text', content: { text } }),
  }).then((r) => r.json()).catch((e) => ({ error: e.message }));
}

const manager = new SessionManager({
  dataDir: DATA_DIR,
  baseUrl: BASE,
  authToken: AUTH_TOKEN,
  onChange: (s) => broadcast({ type: 'session', session: s.deleted ? { id: s.id, deleted: true } : publicSession(s) }),
  onNotify: (s, reason) => {
    broadcast({ type: 'notify', id: s.id, name: s.name, reason, statusLine: s.statusLine });
    // 出圈推送:决策/权限/阻塞必推,完成待审按配置;去重由状态机的 lastNotified 保证
    if (reason !== 'review_ready' || config.notifyReviewReady) {
      pushFeishu(`[CCTower] ${s.name} · ${REASON_LABEL[reason] || reason}\n${s.statusLine}`);
    }
  },
});

function publicSession(s) {
  const { events, ...rest } = s;
  return { ...rest, events: events.slice(-60) };
}

// ---------- REST API ----------
app.get('/api/sessions', (_req, res) => {
  res.json(manager.list().map(publicSession));
});

app.post('/api/sessions', (req, res) => {
  try {
    const { name, type, projectDir, command, isolate } = req.body || {};
    if (!['terminal', 'claude'].includes(type)) return res.status(400).json({ error: 'type 必须是 terminal 或 claude' });
    const s = manager.createSession({ name, type, projectDir, command, isolate });
    res.json(publicSession(s));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// worktree session 的改动全览(含未提交与未跟踪文件)
app.get('/api/sessions/:id/diff', (req, res) => {
  try { res.json(manager.diff(req.params.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/sessions/:id/input', (req, res) => {
  const ok = manager.sendInput(req.params.id, String(req.body.text || ''), { record: req.body.record || null });
  res.json({ delivered: ok });
});

app.post('/api/sessions/:id/action', (req, res) => {
  const { op, value } = req.body || {};
  const id = req.params.id;
  const ops = {
    stop: () => manager.stop(id),
    restart: () => manager.restart(id),
    rename: () => manager.rename(id, value),
    archive: () => manager.archive(id, true),
    unarchive: () => manager.archive(id, false),
    delete: () => manager.remove(id),
    'refresh-brief': () => manager.refreshBrief(id),
    redraw: () => manager.redraw(id),
    'approve-permission': () => manager.permissionAction(id, true),
    'deny-permission': () => manager.permissionAction(id, false),
    finish: () => manager.finish(id),
    'flag-brief': () => manager.flagBrief(id),
    note: () => manager.setNote(id, value),
    merge: () => manager.merge(id),
    'resolve-conflict': () => manager.resolveConflict(id, value || {}),
  };
  if (!ops[op]) return res.status(400).json({ error: `未知操作 ${op}` });
  try {
    const out = ops[op]();
    res.json(out && typeof out === 'object' ? out : { ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Claude Code hooks 回调(本机 hook 通过 curl 调用)
app.post('/api/hook/:id/:event', (req, res) => {
  manager.applyHook(req.params.id, req.params.event, req.body || {});
  res.json({ ok: true });
});

// Agent 主动上报结构化状态(report_status 协议)
app.post('/api/report/:id', (req, res) => {
  const ok = manager.applyReport(req.params.id, req.body || {});
  res.json({ ok });
});

// 目录浏览(新建 session 的 UI 选择器):只列子目录,标记 git 仓库
app.get('/api/fs', (req, res) => {
  try {
    const p = path.resolve(String(req.query.path || '') || require('os').homedir());
    const dirs = fs.readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => {
        let isGit = false;
        try { isGit = fs.existsSync(path.join(p, e.name, '.git')); } catch { /* 无权限 */ }
        return { name: e.name, isGit };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(p);
    res.json({ path: p, parent: parent !== p ? parent : null, isGit: fs.existsSync(path.join(p, '.git')), dirs });
  } catch (e) {
    res.status(400).json({ error: String(e.message).split('\n')[0] });
  }
});

// 最近使用过的项目目录(新建 session 下拉候选)
app.get('/api/projects', (_req, res) => {
  const seen = new Map();
  for (const s of manager.list()) {
    seen.set(s.projectDir, Math.max(seen.get(s.projectDir) || 0, Date.parse(s.lastActivityAt) || 0));
  }
  seen.set(process.cwd(), seen.get(process.cwd()) || 1);
  const dirs = [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d).slice(0, 12);
  res.json({ dirs });
});

app.get('/api/settings', (_req, res) => res.json({ ...config, authToken: config.authToken ? '(已设置)' : '' }));
app.post('/api/settings', (req, res) => {
  const { feishuWebhook, notifyReviewReady } = req.body || {};
  if (feishuWebhook !== undefined) {
    const url = String(feishuWebhook).trim();
    if (url && !/^https:\/\//.test(url)) return res.status(400).json({ error: 'webhook 必须是 https URL' });
    config.feishuWebhook = url;
  }
  if (notifyReviewReady !== undefined) config.notifyReviewReady = !!notifyReviewReady;
  saveConfig();
  res.json(config);
});
app.post('/api/settings/test', async (_req, res) => {
  const r = await pushFeishu('[CCTower] 测试消息:通知链路正常 ✅');
  res.json(r);
});

app.get('/api/health', (_req, res) => res.json({ ok: true, sessions: manager.list().length }));

// ---------- static ----------
const NM = path.join(__dirname, '..', 'node_modules');
app.use('/vendor/xterm.js', express.static(path.join(NM, '@xterm/xterm/lib/xterm.js')));
app.use('/vendor/xterm.css', express.static(path.join(NM, '@xterm/xterm/css/xterm.css')));
app.use('/vendor/addon-fit.js', express.static(path.join(NM, '@xterm/addon-fit/lib/addon-fit.js')));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- server + ws ----------
const server = http.createServer(app);
const wss = new WebSocketServer({
  noServer: true,
  // 浏览器要求服务端在握手中回选一个子协议,否则会主动断开
  handleProtocols: (protocols) => {
    for (const p of protocols) if (p.startsWith('ccw.token.')) return p;
    return false;
  },
});

server.on('upgrade', (req, socket, head) => {
  if (!isLocalRequest(req.headers)) { socket.destroy(); return; }
  const url = new URL(req.url, BASE);
  if (!authOk(req)) { socket.destroy(); return; }
  if (url.pathname === '/ws/events') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      eventClients.add(ws);
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('close', () => eventClients.delete(ws));
      ws.send(JSON.stringify({ type: 'snapshot', sessions: manager.list().map(publicSession) }));
    });
  } else if (url.pathname.startsWith('/ws/term/')) {
    const id = url.pathname.split('/').pop();
    wss.handleUpgrade(req, socket, head, (ws) => manager.attach(id, ws));
  } else {
    socket.destroy();
  }
});

// 迷你终端画面推送:2 秒一次,只推有变化的 session
setInterval(() => {
  for (const u of manager.collectTails()) broadcast({ type: 'tail', id: u.id, tail: u.tail, html: u.html });
}, 2000);

// 心跳保活:上一轮未回 pong 的视为死连接并 terminate(浏览器自动回 pong)
setInterval(() => {
  for (const ws of eventClients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch { } continue; }
    ws.isAlive = false;
    if (ws.readyState === 1) { try { ws.ping(); } catch { } }
  }
  manager.pingClients();
}, 15_000);

server.listen(PORT, HOST, () => {
  console.log(`CCTower 已启动: ${BASE}`);
});
