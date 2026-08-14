'use strict';
const path = require('node:path');
const express = require('express');
const { WebSocketServer } = require('ws');
const {
  verifyPassword, signSession, verifySession, buildCookie, clearCookie,
  parseCookies, RateLimiter, SESSION_COOKIE, SESSION_TTL_SEC,
} = require('./auth');
const { proxyHttp, bridgeWebSocket } = require('./proxy');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp({ store, hub, secureCookie = true } = {}) {
  const app = express();
  // 只信任离网关最近的这一跳(Caddy),不能用 true:true 表示信任整条 X-Forwarded-For
  // 链条,攻击者会在自己发出的请求里伪造这个头、每次换一个假 IP,导致 req.ip 每次
  // 都不同,登录限速(按 IP 计数)直接被绕过——这是暴力破解密码的唯一防线。
  app.set('trust proxy', 1);
  const secret = store.ensureSecret();
  const limiter = new RateLimiter({ limit: 5, windowMs: 60_000 });

  const sessionOk = (headers) => {
    const token = parseCookies(headers.cookie)[SESSION_COOKIE];
    return !!verifySession(secret, token);
  };

  // 用 {root} 形式而不是拼好的绝对路径:send 模块的 dotfile 检查会扫描整条路径的
  // 每一段,项目若被放在带点号的目录下(如 .claude/…)拼绝对路径会被误判成点文件而 404
  app.get('/login', (_req, res) => res.sendFile('login.html', { root: PUBLIC_DIR }));
  // 登录页自己要用这份样式表,必须在认证中间件之前放行;但只精确放行这一个文件,
  // 不能把整个 static 中间件搬到认证前面——总览页的 overview.js 等资源仍必须登录后才能拿到
  app.get('/gateway.css', (_req, res) => res.sendFile('gateway.css', { root: PUBLIC_DIR }));

  // express.json() 只挂这一条路由:全局挂载会吞掉待代理请求的请求体
  app.post('/api/login', express.json({ limit: '4kb' }), (req, res) => {
    const key = req.ip || 'unknown';
    if (!limiter.allow(key)) return res.status(429).json({ error: '尝试过于频繁,请一分钟后再试' });
    const { passwordHash } = store.getConfig();
    if (!passwordHash || !verifyPassword((req.body || {}).password || '', passwordHash)) {
      return res.status(401).json({ error: '密码错误' });
    }
    limiter.reset(key);
    const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
    res.setHeader('Set-Cookie', buildCookie(signSession(secret, exp), { secure: secureCookie }));
    res.json({ ok: true });
  });

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearCookie({ secure: secureCookie }));
    res.json({ ok: true });
  });

  app.use((req, res, next) => {
    if (sessionOk(req.headers)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
    res.redirect(302, '/login');
  });

  // ---------- 以下均需已登录 ----------
  app.get('/', (_req, res) => res.sendFile('overview.html', { root: PUBLIC_DIR }));
  app.get('/api/overview', (_req, res) => res.json({ servers: hub.overview() }));
  app.use('/s/:id', (req, res) => {
    const id = req.params.id;
    // express 的路由匹配默认不区分尾斜杠(strict routing 关闭),挂载点 '/s/:id' 下
    // '/s/<id>' 与 '/s/<id>/' 剥前缀后 req.path 都是 '/',没法在这里分辨;必须看
    // req.originalUrl 才知道浏览器原始请求到底带没带尾斜杠。只有恰好等于不带尾斜杠
    // 的那个精确路径时才需要重定向补斜杠——否则会把已经带斜杠的请求也重定向到
    // 它自己,造成死循环(浏览器/undici 报 redirect count exceeded)。
    // 不补尾斜杠的话,页面里的相对路径资源会解析到 /s/ 下面去,所以仍要补一次。
    if (req.originalUrl === `/s/${id}`) return res.redirect(301, `/s/${id}/`);
    proxyHttp(hub, id, req, res, req.url || '/');
  });
  app.use(express.static(PUBLIC_DIR));

  // ---------- WebSocket ----------
  const wssTunnel = new WebSocketServer({ noServer: true });
  const wssBrowser = new WebSocketServer({
    noServer: true,
    // 浏览器若请求了子协议就得回选一个,否则它会主动断开;没请求就不加这个头
    handleProtocols: (protocols) => (protocols && protocols.size ? [...protocols][0] : false),
  });

  function handleUpgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url, 'http://gateway.local'); } catch { return socket.destroy(); }

    if (url.pathname === '/tunnel') {
      const auth = String(req.headers.authorization || '');
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      const server = store.findByToken(token);
      if (!server) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return socket.destroy();
      }
      return wssTunnel.handleUpgrade(req, socket, head, (ws) => hub.attach(server, ws));
    }

    const m = url.pathname.match(/^\/s\/([A-Za-z0-9_-]+)(\/.*)$/);
    if (!m) return socket.destroy();
    if (!sessionOk(req.headers)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    return wssBrowser.handleUpgrade(req, socket, head, (ws) => bridgeWebSocket(hub, m[1], ws, m[2] + url.search));
  }

  return { app, handleUpgrade };
}

module.exports = { createApp };
