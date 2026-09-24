'use strict';
// 代理层要做到"透明":浏览器感觉不到中间隔着一条隧道。
// 这里用假 Hub 直接对接一个内存 agent,验证请求/响应/离线三条路径。
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { Mux } = require('../shared/tunnel/mux');
const { proxyHttp, bridgeWebSocket, sanitizeRequestHeaders } = require('../gateway/src/proxy');
const { packWsMessage, unpackWsMessage } = require('../shared/tunnel/frames');

// 假 Hub:open() 直接返回一条与"agent 侧 Mux"相连的流
function hubWithAgent(agentHandler) {
  let gw, ag;
  gw = new Mux({ initiator: true, send: (p, b) => queueMicrotask(() => ag.handleMessage(p, b)) });
  ag = new Mux({ initiator: false, send: (p, b) => queueMicrotask(() => gw.handleMessage(p, b)) });
  ag.on('stream', agentHandler);
  return { open: (id, meta) => (id === 'off' ? null : gw.open(meta)) };
}

function listenOnce(handler) {
  const srv = http.createServer(handler);
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}

test('请求头净化:去掉 cookie/host 等,保留业务头', () => {
  const h = sanitizeRequestHeaders({
    cookie: 'ccgw_session=x', host: 'cc.example.com', origin: 'https://cc.example.com',
    connection: 'keep-alive', 'content-type': 'application/json', 'x-ccw-token': '伪造',
  });
  assert.equal(h.cookie, undefined);
  assert.equal(h.host, undefined);
  assert.equal(h.origin, undefined);
  assert.equal(h.connection, undefined);
  assert.equal(h['x-ccw-token'], undefined, '本机令牌只能由 agent 注入');
  assert.equal(h['content-type'], 'application/json');
});

test('HTTP 代理:请求方法/路径/体到达 agent,响应原样回浏览器', async (t) => {
  let seenMeta = null;
  let seenBody = '';
  const hub = hubWithAgent((s) => {
    seenMeta = s.meta;
    s.on('data', (c) => { seenBody += c.toString('utf8'); });
    s.on('end', () => {
      s.headers({ status: 201, headers: { 'content-type': 'application/json' } });
      s.write(Buffer.from('{"id":"abc"}'));
      s.end();
    });
  });

  const { srv, port } = await listenOnce((req, res) => proxyHttp(hub, 'srv1', req, res, req.url));
  // 用 t.after 而不是尾部裸调用 close():断言失败会提前抛出并跳过尾部代码,
  // 裸调用会让监听中的 server 一直挂着,进程再也退不出去(挂起而非快速失败)。
  t.after(() => srv.close());
  const r = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}',
  });
  assert.equal(r.status, 201);
  assert.equal(await r.text(), '{"id":"abc"}');
  assert.equal(seenMeta.method, 'POST');
  assert.equal(seenMeta.path, '/api/sessions');
  assert.equal(seenBody, '{"name":"x"}');
});

test('HTTP 代理:服务器离线返回 502 中文页面', async (t) => {
  const hub = hubWithAgent(() => {});
  const { srv, port } = await listenOnce((req, res) => proxyHttp(hub, 'off', req, res, req.url));
  t.after(() => srv.close());
  const r = await fetch(`http://127.0.0.1:${port}/api/sessions`);
  assert.equal(r.status, 502);
  const text = await r.text();
  assert.match(text, /离线/);
});

// 终审 I-4:两层头部净化各自只有纯函数直测,从未验证"调用方真的调用了它们"——
// 把 proxyHttp 里 sanitizeRequestHeaders(req.headers) 悄悄改回 req.headers,
// 之前全部 141 个用例照样全绿。这里直接测真实调用点 proxyHttp(),而不是绕过它
// 直接调 sanitizeRequestHeaders() 纯函数,才能钉住"调用方真的在用它"这件事。
test('HTTP 代理调用点(I-4 网关侧):cookie/origin/伪造 x-ccw-token 不会被塞进发给 agent 的流', async (t) => {
  let seenMeta = null;
  const hub = hubWithAgent((s) => {
    seenMeta = s.meta;
    s.on('end', () => { s.headers({ status: 200, headers: {} }); s.end(); });
  });
  const { srv, port } = await listenOnce((req, res) => proxyHttp(hub, 'srv1', req, res, req.url));
  t.after(() => srv.close());
  const r = await fetch(`http://127.0.0.1:${port}/x`, {
    headers: {
      cookie: 'ccgw_session=real-session',
      origin: 'http://evil.example',
      referer: 'http://evil.example/',
      'x-ccw-token': 'ATTACKER-SUPPLIED',
      'x-business': 'keep-me',
    },
  });
  assert.equal(r.status, 200);
  assert.ok(seenMeta, '流应该已经打开,agent 才有机会看见 meta');
  assert.equal(seenMeta.headers.cookie, undefined, 'proxyHttp 必须真的调用净化函数,而不是透传原始 headers');
  assert.equal(seenMeta.headers.origin, undefined);
  assert.equal(seenMeta.headers.referer, undefined);
  assert.equal(seenMeta.headers['x-ccw-token'], undefined, '浏览器伪造的 x-ccw-token 不能带过隧道');
  assert.equal(seenMeta.headers['x-business'], 'keep-me', '业务头应该保留');
});

test('HTTP 代理:agent 中途报错且尚未发响应头时,回 502 而不是挂死', async (t) => {
  const hub = hubWithAgent((s) => s.on('end', () => s.fail('本机 CCTower 没起来')));
  const { srv, port } = await listenOnce((req, res) => proxyHttp(hub, 'srv1', req, res, req.url));
  t.after(() => srv.close());
  const r = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(r.status, 502);
});

// 终审 M-3:被代理机器回的响应头本身是外部输入,畸形值(比如带 CRLF)会让
// res.writeHead 同步抛异常。hub.js 的帧级 try/catch 会把这个异常整个吞掉,浏览器
// 请求永久挂起(无 502、无超时)。这里直接在 proxy.js 这一层验证:异常必须被兜住,
// 明确回 502,而不是让它冒出去。
test('响应头非法时回 502,而不是让浏览器永久挂起(M-3)', async (t) => {
  const hub = hubWithAgent((s) => {
    s.on('end', () => {
      s.headers({ status: 200, headers: { 'x-evil': 'bad\r\nvalue' } });
      s.end();
    });
  });
  const { srv, port } = await listenOnce((req, res) => proxyHttp(hub, 'srv1', req, res, req.url));
  t.after(() => srv.close());
  const r = await fetch(`http://127.0.0.1:${port}/x`);
  assert.equal(r.status, 502, '非法响应头必须转成 502,而不是挂起');
});

// 终审 I-6(可低成本收敛的一点):路径式代理让所有被代理机器与网关 UI 共用同一个
// origin。被攻陷的机器如果在响应里夹带一个与网关会话同名的 Set-Cookie,能覆盖用户
// 当前登录会话——HttpOnly 挡不住这种"响应体自己设置"的路径。网关必须过滤掉同名 cookie。
test('响应头净化:被代理机器不能用 Set-Cookie 覆盖网关自己的会话 cookie(I-6)', async (t) => {
  const hub = hubWithAgent((s) => {
    s.on('end', () => {
      s.headers({
        status: 200,
        headers: {
          'set-cookie': ['ccgw_session=ATTACKER-FORGED; Path=/', 'app_theme=dark; Path=/'],
          'content-type': 'text/html',
        },
      });
      s.end();
    });
  });
  const { srv, port } = await listenOnce((req, res) => proxyHttp(hub, 'srv1', req, res, req.url));
  t.after(() => srv.close());
  const r = await fetch(`http://127.0.0.1:${port}/`);
  const setCookies = r.headers.getSetCookie();
  assert.ok(!setCookies.some((c) => c.startsWith('ccgw_session=')), '被代理机器不能覆盖网关会话 cookie');
  assert.ok(setCookies.some((c) => c.startsWith('app_theme=')), '业务 cookie 应该原样保留');
});

// 复审 R-1:startsWith 前缀匹配能被前导空白绕过——` ccgw_session=X` 不以
// `ccgw_session=` 开头,能穿过旧过滤器;但 Node 序列化响应头时会去掉这个前导
// 空白,浏览器收到的字节与合法会话 cookie 完全一致。必须按 cookie 名精确解析。
test('响应头净化:Set-Cookie 前导空格/tab 不能绕过同名过滤(R-1)', async (t) => {
  const hub = hubWithAgent((s) => {
    s.on('end', () => {
      s.headers({
        status: 200,
        headers: {
          'set-cookie': [
            ' ccgw_session=ATTACKER-SPACE; Path=/',
            '\tccgw_session=ATTACKER-TAB; Path=/',
            'ccgw_session=ATTACKER-PLAIN; Path=/',
            'app_theme=dark; Path=/',
          ],
          'content-type': 'text/html',
        },
      });
      s.end();
    });
  });
  const { srv, port } = await listenOnce((req, res) => proxyHttp(hub, 'srv1', req, res, req.url));
  t.after(() => srv.close());
  const r = await fetch(`http://127.0.0.1:${port}/`);
  const setCookies = r.headers.getSetCookie();
  assert.ok(
    !setCookies.some((c) => c.trim().startsWith('ccgw_session=')),
    `带前导空白的伪造会话 cookie 必须被过滤,实际收到:${JSON.stringify(setCookies)}`,
  );
  assert.ok(setCookies.some((c) => c.startsWith('app_theme=')), '不该误伤其它正常业务 cookie');
});

test('WS 桥接:双向消息与 text/binary 语义保持', async () => {
  const hub = hubWithAgent((s) => {
    s.headers({ open: true });
    s.on('data', (buf) => {
      const m = unpackWsMessage(buf);
      s.write(packWsMessage(Buffer.concat([Buffer.from('echo:'), m.data]), m.isBinary));
    });
  });
  const browser = new EventEmitter();
  browser.readyState = 1;
  browser.sent = [];
  browser.send = (d, o) => browser.sent.push({ d, binary: !!(o && o.binary) });
  browser.close = () => { browser.readyState = 3; browser.closed = true; };

  bridgeWebSocket(hub, 'srv1', browser, '/ws/term/1');
  browser.emit('message', Buffer.from('hi'), false);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(browser.sent[0].d.toString('utf8'), 'echo:hi');
  assert.equal(browser.sent[0].binary, false);
});

test('WS 桥接:服务器离线时立刻关掉浏览器连接(不让它空等)', () => {
  const hub = hubWithAgent(() => {});
  const browser = new EventEmitter();
  browser.readyState = 1;
  browser.send = () => {};
  let closeCode = null;
  browser.close = (code) => { closeCode = code; browser.readyState = 3; };
  bridgeWebSocket(hub, 'off', browser, '/ws/events');
  assert.equal(closeCode, 1011);
});
