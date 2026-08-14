'use strict';
const WebSocket = require('ws');
const { Mux } = require('../shared/tunnel/mux');
const { nextDelay } = require('./src/backoff');
const { handleStream } = require('./src/forward');
const { loadConfig } = require('./src/config');

function createAgent(config, {
  WebSocketImpl = WebSocket,
  log = console.error,
  sweepMs = 15_000,
  // 比网关侧的 30s 宽松:让网关先动手断开,两边同时判死会来回抖
  deadAfterMs = 45_000,
  backoff = {},
} = {}) {
  let ws = null;
  let mux = null;
  let attempt = 0;
  let stopped = false;
  let running = false; // start() 幂等保护:不经 stop 连续调两次会覆盖 sweepTimer(泄漏)并制造两条活跃 socket
  let reconnectTimer = null;
  let sweepTimer = null;
  let lastFrameAt = 0;

  function connect() {
    if (stopped) return;
    const sock = new WebSocketImpl(config.gatewayUrl, { headers: { Authorization: `Bearer ${config.token}` } });
    ws = sock;
    lastFrameAt = Date.now();
    const m = new Mux({ send: (payload, isBinary) => { if (sock.readyState === 1) sock.send(payload, { binary: isBinary }); } });
    mux = m;
    m.on('stream', (s) => handleStream(s, config));

    sock.on('open', () => { attempt = 0; log('[agent] 已接入网关'); });
    sock.on('message', (data, isBinary) => {
      lastFrameAt = Date.now();
      // 一个坏帧不该拖垮整条隧道:记下来继续跑
      try { m.handleMessage(data, isBinary); } catch (e) { log(`[agent] 丢弃坏帧:${e.message}`); }
    });
    sock.on('error', (e) => log(`[agent] 连接错误:${e.message}`));
    sock.on('close', () => {
      if (sock !== ws) return; // 旧连接的迟到事件,别干扰新连接
      m.closeAll('隧道断开');
      ws = null;
      mux = null;
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = nextDelay(attempt++, backoff);
    log(`[agent] ${delay}ms 后重连`);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  function sweep() {
    if (!ws || ws.readyState !== 1) return;
    if (Date.now() - lastFrameAt > deadAfterMs) {
      log('[agent] 隧道疑似半死,主动断开重连');
      try { ws.terminate(); } catch { /* 已关 */ }
    }
  }

  return {
    start() {
      // 已经在跑就直接忽略:重复 start 不该覆盖 sweepTimer 引用(定时器泄漏)或另开一条 socket。
      // 真要重启,调用方应显式先 stop() 再 start(),语义更清楚,也不会有"哪条连接才是当前连接"的歧义。
      if (running) return;
      running = true;
      stopped = false;
      connect();
      sweepTimer = setInterval(sweep, sweepMs);
      if (sweepTimer.unref) sweepTimer.unref();
    },
    stop() {
      running = false;
      stopped = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
      const sock = ws;
      ws = null;
      if (mux) mux.closeAll('agent 停止');
      mux = null;
      if (sock) { try { sock.close(); } catch { /* 已关 */ } }
    },
    isConnected() { return !!ws && ws.readyState === 1; },
  };
}

module.exports = { createAgent };

if (require.main === module) {
  let config;
  try { config = loadConfig(); }
  catch (e) { console.error(`[agent] 配置错误:${e.message}`); process.exit(1); }
  const agent = createAgent(config);
  agent.start();
  const bye = () => { agent.stop(); process.exit(0); };
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}
