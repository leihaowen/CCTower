'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');
const { SessionManager } = require('./manager');

const PORT = Number(process.env.CCW_PORT || 7080);
const HOST = '127.0.0.1'; // PRD §8 安全要求:默认只绑定 localhost
const BASE = `http://${HOST}:${PORT}`;
const DATA_DIR = path.join(__dirname, '..', '.ccw-data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------- websocket fan-out ----------
const eventClients = new Set();
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of eventClients) if (ws.readyState === 1) ws.send(msg);
}

const manager = new SessionManager({
  dataDir: DATA_DIR,
  baseUrl: BASE,
  onChange: (s) => broadcast({ type: 'session', session: s.deleted ? { id: s.id, deleted: true } : publicSession(s) }),
  onNotify: (s, reason) => broadcast({ type: 'notify', id: s.id, name: s.name, reason, statusLine: s.statusLine }),
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
    'flag-brief': () => manager.flagBrief(id),
    note: () => manager.setNote(id, value),
  };
  if (!ops[op]) return res.status(400).json({ error: `未知操作 ${op}` });
  ops[op]();
  res.json({ ok: true });
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

app.get('/api/health', (_req, res) => res.json({ ok: true, sessions: manager.list().length }));

// ---------- static ----------
const NM = path.join(__dirname, '..', 'node_modules');
app.use('/vendor/xterm.js', express.static(path.join(NM, '@xterm/xterm/lib/xterm.js')));
app.use('/vendor/xterm.css', express.static(path.join(NM, '@xterm/xterm/css/xterm.css')));
app.use('/vendor/addon-fit.js', express.static(path.join(NM, '@xterm/addon-fit/lib/addon-fit.js')));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- server + ws ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, BASE);
  if (url.pathname === '/ws/events') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      eventClients.add(ws);
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

server.listen(PORT, HOST, () => {
  console.log(`Agent Workbench MVP 已启动: ${BASE}`);
});
