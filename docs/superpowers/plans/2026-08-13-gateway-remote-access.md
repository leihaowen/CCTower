# CCTower 远程访问网关(一期)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在任何网络(含手机浏览器)通过一个 HTTPS 域名,登录后聚合查看并直接操作分布在公网/NAT 后的多台服务器上的 CCTower。

**Architecture:** 新增三个 Node.js 组件——`shared/tunnel/`(WebSocket 上的多路复用隧道协议)、`agent/`(装在每台服务器上,出站连网关,把流量转发到本机 127.0.0.1:7080)、`gateway/`(公网单点:登录认证 + 服务器注册表 + 反向代理 + 聚合总览)。各服务器的 CCTower 保持只监听回环、服务端代码零改动;现有前端只做"路径前缀感知"的向后兼容改造。

**Tech Stack:** Node.js ≥20(CommonJS)、express 5、ws 8、Node 内置 crypto(scrypt/HMAC/SHA-256)、`node --test`;TLS 由外部 Caddy 承担。

规格来源:`docs/superpowers/specs/2026-08-13-gateway-remote-access-design.md`。

## Global Constraints

- Node ≥ 20;仓库根是 **CommonJS**(`"type": "commonjs"`),`gateway/`、`agent/`、`shared/` 全部写 CJS(`require`/`module.exports`),不要写 ESM。
- **不引入任何新的 npm 依赖**:gateway 复用根依赖(express、ws);agent 只依赖 ws。
- **`server/` 目录零改动**。唯一允许改动的既有前端文件是 `public/app.js` 与 `public/index.html`(仅前缀感知,见 Task 13),且必须保持直连本机时行为不变。
- 各服务器的 CCTower 继续只监听 `127.0.0.1`;本机 `CCW_TOKEN` 只由 agent 注入,绝不出现在网关存储或浏览器里。
- 测试文件放置:网关/隧道/E2E 测试放根 `test/`,命名 `gateway-*.test.js` / `tunnel-*.test.js`;agent 测试放 `agent/test/`。
- 测试脚本的 glob **不能加引号**(`node --test test/*.test.js`),Node 20 不自行展开引号内的 glob。
- 每个提交必须 `git commit -s`(仓库启用 DCO 机器人,不签署会被拦)。
- 中文注释与中文用户可见文案,风格与现有代码一致:注释解释"为什么",不解释"是什么"。
- 会话状态取值以 `public/app.js` 的 `STATUS` 为准:`ready`(就绪)、`executing`(执行中)、`verifying`(验证中)、`needs_decision`(需要决策)、`needs_permission`(需要权限)、`blocked`(阻塞)、`review_ready`(待审核)、`completed`(已完成)、`stale`(无进展)、`terminal_only`(终端)、`exited`(已退出)。需注意状态集合为 `needs_decision`/`needs_permission`/`blocked`/`review_ready`。

## 文件结构

| 文件 | 职责 |
|------|------|
| `shared/tunnel/frames.js` | 帧编解码:控制帧(JSON text)、数据帧(4 字节 streamId + 负载)、WS 消息的 text/binary 打包 |
| `shared/tunnel/mux.js` | 一条 WS 上的流多路复用:`Mux` + `Stream` |
| `gateway/src/store.js` | 注册表与配置持久化(servers.json / config.json),token 生成与哈希 |
| `gateway/src/auth.js` | scrypt 密码、签名会话 cookie、登录限速、cookie 解析 |
| `gateway/src/watcher.js` | 会话状态归并(从 `desktop/src/core/watcher.js` 移植为 CJS,增加 `statusCounts`) |
| `gateway/src/hub.js` | 隧道生命周期:接入、踢旧、心跳、事件订阅、聚合总览数据 |
| `gateway/src/proxy.js` | HTTP 代理与 WebSocket 桥接 |
| `gateway/src/app.js` | express 组装 + upgrade 分派 |
| `gateway/index.js` | 网关进程入口 |
| `gateway/cli.js` | `add-server` / `list-servers` / `remove-server` / `set-password` |
| `gateway/public/` | 登录页与聚合总览页(login.html、overview.html、overview.js、gateway.css) |
| `agent/index.js` | agent 进程入口:连接主循环 + 退避重连 + 心跳 |
| `agent/src/config.js` | 配置读取与校验 |
| `agent/src/backoff.js` | 指数退避 |
| `agent/src/forward.js` | 把隧道流转成本机 HTTP/WS 请求(含本机 token 注入与请求净化) |
| `agent/install.sh` | 一条命令安装 agent + systemd 单元 |
| `public/prefix.js` | 路径前缀推导(浏览器与 Node 双用) |
| `deploy/` | systemd 单元 + Caddyfile 示例 |
| `docs/GATEWAY.md` | 部署与使用文档 |

---

### Task 1: 隧道帧编解码

**Files:**
- Create: `shared/tunnel/frames.js`
- Test: `test/tunnel-frames.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `encodeControl(frame) -> string`、`decodeControl(text) -> {streamId, kind, meta}`、`encodeData(streamId, payload) -> Buffer`、`decodeData(buf) -> {streamId, payload}`、`packWsMessage(data, isBinary) -> Buffer`、`unpackWsMessage(buf) -> {data, isBinary}`、`KINDS: Set<string>`

- [ ] **Step 1: 写失败的测试**

创建 `test/tunnel-frames.test.js`:

```js
'use strict';
// 隧道帧是 gateway 与 agent 之间唯一的语言,编解码错一位整条隧道就哑了,
// 所以这里把每种帧的往返、以及所有会被对端塞进来的坏输入都钉死。
const test = require('node:test');
const assert = require('node:assert');
const {
  encodeControl, decodeControl, encodeData, decodeData,
  packWsMessage, unpackWsMessage,
} = require('../shared/tunnel/frames');

test('控制帧往返:open 帧的 meta 原样保留', () => {
  const frame = { streamId: 7, kind: 'open', meta: { type: 'http', method: 'GET', path: '/api/sessions' } };
  const back = decodeControl(encodeControl(frame));
  assert.deepEqual(back, frame);
});

test('控制帧往返:无 meta 的帧解码后 meta 为 null', () => {
  const back = decodeControl(encodeControl({ streamId: 3, kind: 'end' }));
  assert.deepEqual(back, { streamId: 3, kind: 'end', meta: null });
});

test('控制帧:未知 kind 编码与解码都报错', () => {
  assert.throws(() => encodeControl({ streamId: 1, kind: 'hack' }), /未知帧类型/);
  assert.throws(() => decodeControl('{"streamId":1,"kind":"hack"}'), /未知帧类型/);
});

test('控制帧:非法 streamId 被拒', () => {
  assert.throws(() => encodeControl({ streamId: -1, kind: 'end' }), /streamId/);
  assert.throws(() => decodeControl('{"streamId":1.5,"kind":"end"}'), /streamId/);
  assert.throws(() => decodeControl('{"kind":"end"}'), /streamId/);
});

test('控制帧:坏 JSON 与非对象都报错而不是崩掉', () => {
  assert.throws(() => decodeControl('not json'), /合法 JSON/);
  assert.throws(() => decodeControl('42'), /必须是对象/);
});

test('数据帧往返:大 streamId 与二进制负载都不失真', () => {
  const payload = Buffer.from([0, 1, 2, 255, 254]);
  const { streamId, payload: back } = decodeData(encodeData(4294967295, payload));
  assert.equal(streamId, 4294967295);
  assert.deepEqual(Buffer.from(back), payload);
});

test('数据帧:空负载合法,不足 4 字节报错', () => {
  const { streamId, payload } = decodeData(encodeData(9, Buffer.alloc(0)));
  assert.equal(streamId, 9);
  assert.equal(payload.length, 0);
  assert.throws(() => decodeData(Buffer.from([1, 2])), /不足 4 字节/);
});

test('WS 消息打包保留 text/binary 语义', () => {
  const t = unpackWsMessage(packWsMessage(Buffer.from('你好'), false));
  assert.equal(t.isBinary, false);
  assert.equal(t.data.toString('utf8'), '你好');

  const b = unpackWsMessage(packWsMessage(Buffer.from([7, 8, 9]), true));
  assert.equal(b.isBinary, true);
  assert.deepEqual(Buffer.from(b.data), Buffer.from([7, 8, 9]));
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `node --test test/tunnel-frames.test.js`
Expected: FAIL,`Cannot find module '../shared/tunnel/frames'`

- [ ] **Step 3: 实现**

创建 `shared/tunnel/frames.js`:

```js
'use strict';
// 一条 WebSocket 上跑很多逻辑流:控制帧走 text(JSON),数据帧走 binary
//(前 4 字节大端 streamId + 负载)。二进制不套 JSON 是为了让终端流量零拷贝、不膨胀。
const KINDS = new Set(['open', 'headers', 'end', 'error', 'ping', 'pong']);

function assertFrame(streamId, kind) {
  if (!KINDS.has(kind)) throw new Error(`未知帧类型 ${kind}`);
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 4294967295) {
    throw new Error('streamId 必须是 0–4294967295 的整数');
  }
}

function encodeControl(frame) {
  const f = frame || {};
  assertFrame(f.streamId, f.kind);
  return JSON.stringify({ streamId: f.streamId, kind: f.kind, meta: f.meta === undefined ? null : f.meta });
}

function decodeControl(text) {
  let obj;
  try { obj = JSON.parse(typeof text === 'string' ? text : Buffer.from(text).toString('utf8')); }
  catch { throw new Error('控制帧不是合法 JSON'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('控制帧必须是对象');
  assertFrame(obj.streamId, obj.kind);
  return { streamId: obj.streamId, kind: obj.kind, meta: obj.meta === undefined ? null : obj.meta };
}

function encodeData(streamId, payload) {
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 4294967295) {
    throw new Error('streamId 必须是 0–4294967295 的整数');
  }
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []);
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(streamId, 0);
  return Buffer.concat([head, body]);
}

function decodeData(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 4) throw new Error('数据帧不足 4 字节,缺 streamId 头');
  return { streamId: b.readUInt32BE(0), payload: b.subarray(4) };
}

// 透传浏览器 WebSocket 时,text 与 binary 的区别必须原样送到对端:
// xterm 的输入是 text,终端输出可能是 binary,弄反了页面会显示乱码。
function packWsMessage(data, isBinary) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return Buffer.concat([Buffer.from([isBinary ? 1 : 0]), body]);
}

function unpackWsMessage(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 1) throw new Error('WS 消息缺少 text/binary 标记字节');
  return { data: b.subarray(1), isBinary: b[0] === 1 };
}

module.exports = { encodeControl, decodeControl, encodeData, decodeData, packWsMessage, unpackWsMessage, KINDS };
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `node --test test/tunnel-frames.test.js`
Expected: PASS(8 tests)

- [ ] **Step 5: 提交**

```bash
git add shared/tunnel/frames.js test/tunnel-frames.test.js
git commit -s -m "feat(tunnel): 隧道帧编解码"
```

---

### Task 2: 隧道多路复用

**Files:**
- Create: `shared/tunnel/mux.js`
- Test: `test/tunnel-mux.test.js`

**Interfaces:**
- Consumes: Task 1 的 `encodeControl` / `decodeControl` / `encodeData` / `decodeData`
- Produces:
  - `new Mux({ send, initiator })`,`send(payload, isBinary)` 由调用方绑定到 WebSocket
  - `mux.open(meta) -> Stream`、`mux.handleMessage(data, isBinary)`、`mux.sendPing()`、`mux.closeAll(reason)`、`mux.streamCount()`
  - Mux 事件:`'stream'(stream)`、`'ping'`、`'pong'`
  - `Stream`:`.id`、`.meta`、`.headers(meta)`、`.write(payload)`、`.end()`、`.fail(message)`;事件 `'headers'(meta)`、`'data'(Buffer)`、`'end'`、`'aborted'(Error)`

**关键设计约定(实现必须遵守):**
- 流的中止事件叫 `'aborted'` 而**不是** `'error'`:EventEmitter 上没有监听者的 `'error'` 事件会直接抛出并打崩进程,而隧道的对端随时可能报错,不能让它有能力打崩我们。
- `end` 是**半关闭**:表示"我这边没有更多数据了",对端仍可继续发。只有两侧都 `end`(或任一侧 `error`)才真正回收流。HTTP 请求体结束用它,响应结束也用它。
- 双方各用一半 streamId 空间(initiator 用奇数,另一侧用偶数),即使将来 agent 也主动开流也不会撞号。

- [ ] **Step 1: 写失败的测试**

创建 `test/tunnel-mux.test.js`:

```js
'use strict';
// Mux 是隧道的心脏:开流、半关闭、清理都错不得。
// 这里用一对内存里互联的 Mux 模拟 gateway ↔ agent,不碰真的 WebSocket。
const test = require('node:test');
const assert = require('node:assert');
const { Mux } = require('../shared/tunnel/mux');

// 把两个 Mux 直接对接:一边 send 出去的东西,下一个微任务进另一边的 handleMessage。
// 异步投递(而不是同步直调)才能复现真实网络下"回调不在同一栈"的时序。
function pair() {
  let a, b;
  a = new Mux({ initiator: true, send: (p, bin) => queueMicrotask(() => b.handleMessage(p, bin)) });
  b = new Mux({ initiator: false, send: (p, bin) => queueMicrotask(() => a.handleMessage(p, bin)) });
  return [a, b];
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('开流:对端收到 stream 事件并拿到 meta', async () => {
  const [a, b] = pair();
  const got = new Promise((res) => b.once('stream', res));
  a.open({ type: 'http', path: '/api/health' });
  const s = await got;
  assert.deepEqual(s.meta, { type: 'http', path: '/api/health' });
});

test('双向数据:请求体与响应体各自送达', async () => {
  const [a, b] = pair();
  const serverSide = new Promise((res) => b.once('stream', res));
  const cs = a.open({ type: 'http', path: '/x' });
  const ss = await serverSide;

  const reqChunks = [];
  ss.on('data', (c) => reqChunks.push(c.toString('utf8')));
  cs.write(Buffer.from('hello '));
  cs.write(Buffer.from('body'));
  cs.end();
  await tick();
  assert.equal(reqChunks.join(''), 'hello body');

  const seen = { headers: null, body: '', ended: false };
  cs.on('headers', (m) => { seen.headers = m; });
  cs.on('data', (c) => { seen.body += c.toString('utf8'); });
  cs.on('end', () => { seen.ended = true; });
  ss.headers({ status: 200, headers: { 'content-type': 'application/json' } });
  ss.write(Buffer.from('{"ok":true}'));
  ss.end();
  await tick();
  assert.equal(seen.headers.status, 200);
  assert.equal(seen.body, '{"ok":true}');
  assert.equal(seen.ended, true);
});

test('半关闭:一侧 end 之后另一侧仍能继续发数据', async () => {
  const [a, b] = pair();
  const serverSide = new Promise((res) => b.once('stream', res));
  const cs = a.open({ type: 'ws', path: '/ws/events' });
  const ss = await serverSide;
  cs.end();                       // 客户端说完了
  await tick();
  const late = [];
  cs.on('data', (c) => late.push(c.toString('utf8')));
  ss.write(Buffer.from('还能发'));  // 服务端继续推
  await tick();
  assert.deepEqual(late, ['还能发']);
});

test('两侧都 end 之后流被回收', async () => {
  const [a, b] = pair();
  const serverSide = new Promise((res) => b.once('stream', res));
  const cs = a.open({ type: 'http', path: '/x' });
  const ss = await serverSide;
  cs.end();
  ss.end();
  await tick();
  assert.equal(a.streamCount(), 0);
  assert.equal(b.streamCount(), 0);
});

test('fail 立刻回收两侧并触发 aborted(而不是 error)', async () => {
  const [a, b] = pair();
  const serverSide = new Promise((res) => b.once('stream', res));
  const cs = a.open({ type: 'http', path: '/x' });
  const ss = await serverSide;
  const aborted = new Promise((res) => cs.on('aborted', res));
  ss.fail('本机 CCTower 没起来');
  const err = await aborted;
  assert.match(err.message, /没起来/);
  await tick();
  assert.equal(a.streamCount(), 0);
  assert.equal(b.streamCount(), 0);
});

test('closeAll:所有在途流都收到 aborted 且清空', async () => {
  const [a, b] = pair();
  const s1 = a.open({ type: 'http', path: '/1' });
  const s2 = a.open({ type: 'http', path: '/2' });
  const seen = [];
  s1.on('aborted', () => seen.push(1));
  s2.on('aborted', () => seen.push(2));
  a.closeAll('隧道断了');
  assert.deepEqual(seen.sort(), [1, 2]);
  assert.equal(a.streamCount(), 0);
});

test('ping 自动回 pong,并对外抛事件', async () => {
  const [a, b] = pair();
  const pong = new Promise((res) => a.once('pong', res));
  const ping = new Promise((res) => b.once('ping', res));
  a.sendPing();
  await ping;
  await pong;
});

test('迟到帧与重复 open 都被静默丢弃,不抛异常', () => {
  const [a] = pair();
  const { encodeControl, encodeData } = require('../shared/tunnel/frames');
  a.handleMessage(encodeControl({ streamId: 999, kind: 'end' }), false);      // 已关闭的流
  a.handleMessage(encodeData(999, Buffer.from('x')), true);
  a.handleMessage(encodeControl({ streamId: 12, kind: 'open', meta: {} }), false);
  a.handleMessage(encodeControl({ streamId: 12, kind: 'open', meta: {} }), false); // 重复 open
  assert.equal(a.streamCount(), 1);
});

test('initiator 与非 initiator 的 streamId 不会撞号', () => {
  const [a, b] = pair();
  assert.equal(a.open({}).id % 2, 1);
  assert.equal(b.open({}).id % 2, 0);
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `node --test test/tunnel-mux.test.js`
Expected: FAIL,`Cannot find module '../shared/tunnel/mux'`

- [ ] **Step 3: 实现**

创建 `shared/tunnel/mux.js`:

```js
'use strict';
const { EventEmitter } = require('node:events');
const { encodeControl, decodeControl, encodeData, decodeData } = require('./frames');

// 中止事件叫 aborted 而不是 error:EventEmitter 上没人监听的 'error' 会直接抛出
// 打崩进程,而这个事件的触发者是网络对端——不能给对端打崩我们的能力。
class Stream extends EventEmitter {
  constructor(mux, id, meta) {
    super();
    this.mux = mux;
    this.id = id;
    this.meta = meta;
    this.localEnded = false;
    this.remoteEnded = false;
    this.destroyed = false;
  }
  headers(meta) {
    if (this.destroyed || this.localEnded) return;
    this.mux._control({ streamId: this.id, kind: 'headers', meta });
  }
  write(payload) {
    if (this.destroyed || this.localEnded) return;
    this.mux._data(this.id, payload);
  }
  end() {
    if (this.destroyed || this.localEnded) return;
    this.localEnded = true;
    this.mux._control({ streamId: this.id, kind: 'end' });
    this.mux._collect(this);
  }
  fail(message) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.mux._control({ streamId: this.id, kind: 'error', meta: { message: String(message || '未知错误') } });
    this.mux._forget(this.id);
  }
}

class Mux extends EventEmitter {
  constructor({ send, initiator = false } = {}) {
    super();
    if (typeof send !== 'function') throw new Error('Mux 需要 send(payload, isBinary)');
    this._send = send;
    this._streams = new Map();
    // 双方各占一半 id 空间,将来两侧都主动开流也不会撞号
    this._nextId = initiator ? 1 : 2;
  }

  open(meta) {
    const id = this._nextId;
    this._nextId += 2;
    const s = new Stream(this, id, meta === undefined ? null : meta);
    this._streams.set(id, s);
    this._control({ streamId: id, kind: 'open', meta: s.meta });
    return s;
  }

  handleMessage(data, isBinary) {
    if (isBinary) {
      const { streamId, payload } = decodeData(data);
      const s = this._streams.get(streamId);
      if (s && !s.destroyed) s.emit('data', payload);
      return;
    }
    const f = decodeControl(data);
    if (f.kind === 'ping') { this._control({ streamId: 0, kind: 'pong' }); this.emit('ping'); return; }
    if (f.kind === 'pong') { this.emit('pong'); return; }
    if (f.kind === 'open') {
      if (this._streams.has(f.streamId)) return; // 重复 open:忽略,别把已有流冲掉
      const s = new Stream(this, f.streamId, f.meta);
      this._streams.set(f.streamId, s);
      this.emit('stream', s);
      return;
    }
    const s = this._streams.get(f.streamId);
    if (!s) return; // 迟到帧:流已回收,静默丢弃
    if (f.kind === 'headers') { s.emit('headers', f.meta); return; }
    if (f.kind === 'end') { s.remoteEnded = true; s.emit('end'); this._collect(s); return; }
    if (f.kind === 'error') {
      s.destroyed = true;
      this._forget(s.id);
      s.emit('aborted', new Error((f.meta && f.meta.message) || '对端中止了这条流'));
    }
  }

  sendPing() { this._control({ streamId: 0, kind: 'ping' }); }

  closeAll(reason) {
    const streams = [...this._streams.values()];
    this._streams.clear();
    for (const s of streams) {
      if (s.destroyed) continue;
      s.destroyed = true;
      s.emit('aborted', new Error(String(reason || '隧道关闭')));
    }
  }

  streamCount() { return this._streams.size; }

  _control(frame) { this._send(encodeControl(frame), false); }
  _data(streamId, payload) { this._send(encodeData(streamId, payload), true); }
  _collect(s) { if (s.localEnded && s.remoteEnded) this._forget(s.id); }
  _forget(id) { this._streams.delete(id); }
}

module.exports = { Mux, Stream };
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `node --test test/tunnel-mux.test.js`
Expected: PASS(9 tests)

- [ ] **Step 5: 提交**

```bash
git add shared/tunnel/mux.js test/tunnel-mux.test.js
git commit -s -m "feat(tunnel): 流多路复用(半关闭语义 + aborted 事件)"
```

---

### Task 3: 网关存储(注册表与配置)

**Files:**
- Create: `gateway/src/store.js`
- Test: `test/gateway-store.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `new Store(dir?)`(默认目录 `process.env.CCTOWER_GATEWAY_DATA` 或 `~/.cctower-gateway`)
  - `.listServers() -> [{id, name, tokenHash, addedAt, lastSeenAt}]`
  - `.addServer(name) -> { server, token }`(token 明文只在此返回一次)
  - `.removeServer(id) -> boolean`
  - `.findByToken(token) -> server|null`
  - `.touch(id) -> void`(更新 lastSeenAt)
  - `.getConfig() -> { port, passwordHash, sessionSecret }`、`.setConfig(patch) -> config`、`.ensureSecret() -> string`
  - 模块级导出:`tokenHash(token)`、`newToken()`

- [ ] **Step 1: 写失败的测试**

创建 `test/gateway-store.test.js`:

```js
'use strict';
// 注册表是"谁能接入网关"的唯一真相。这里钉死三件事:
// token 明文不落盘、删除即吊销、写入是原子的(半截文件会让网关重启后失忆)。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, tokenHash } = require('../gateway/src/store');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-store-'));
  return { store: new Store(dir), dir };
}

test('addServer:返回明文 token,但磁盘上只有哈希', () => {
  const { store, dir } = tmpStore();
  const { server, token } = store.addServer('aws1');
  assert.equal(server.name, 'aws1');
  assert.ok(token.length >= 40, 'token 应该足够长');
  assert.equal(server.tokenHash, tokenHash(token));
  const raw = fs.readFileSync(path.join(dir, 'servers.json'), 'utf8');
  assert.ok(!raw.includes(token), '明文 token 绝不能落盘');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('findByToken:命中正确的服务器,错 token 返回 null', () => {
  const { store, dir } = tmpStore();
  const a = store.addServer('a');
  const b = store.addServer('b');
  assert.equal(store.findByToken(a.token).id, a.server.id);
  assert.equal(store.findByToken(b.token).id, b.server.id);
  assert.equal(store.findByToken('wrong'), null);
  assert.equal(store.findByToken(''), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('removeServer:删除即吊销,token 再也认不出来', () => {
  const { store, dir } = tmpStore();
  const { server, token } = store.addServer('gone');
  assert.equal(store.removeServer(server.id), true);
  assert.equal(store.removeServer(server.id), false, '重复删除返回 false');
  assert.equal(store.findByToken(token), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('touch:更新 lastSeenAt 并持久化', () => {
  const { store, dir } = tmpStore();
  const { server } = store.addServer('s');
  assert.equal(server.lastSeenAt, null);
  store.touch(server.id);
  const fresh = new Store(dir).listServers()[0];
  assert.ok(fresh.lastSeenAt, 'lastSeenAt 应写进磁盘');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('配置:默认值可读,setConfig 合并后持久化', () => {
  const { store, dir } = tmpStore();
  assert.equal(store.getConfig().port, 7081);
  store.setConfig({ passwordHash: 'scrypt$x$y' });
  assert.equal(new Store(dir).getConfig().passwordHash, 'scrypt$x$y');
  assert.equal(new Store(dir).getConfig().port, 7081, '未提供的字段保持默认');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ensureSecret:首次生成并落盘,再次调用返回同一个', () => {
  const { store, dir } = tmpStore();
  const s1 = store.ensureSecret();
  assert.ok(s1.length >= 32);
  assert.equal(store.ensureSecret(), s1);
  assert.equal(new Store(dir).ensureSecret(), s1, '重启后会话不应全部失效');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('坏掉的 servers.json 不让网关起不来,按空列表处理', () => {
  const { store, dir } = tmpStore();
  fs.writeFileSync(path.join(dir, 'servers.json'), '{坏文件');
  assert.deepEqual(store.listServers(), []);
  const { server } = store.addServer('recovered'); // 还能继续写
  assert.equal(new Store(dir).listServers()[0].id, server.id);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('数据目录权限为 0700,配置文件为 0600', () => {
  const { store, dir } = tmpStore();
  store.setConfig({ passwordHash: 'x' });
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, 'config.json')).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `node --test test/gateway-store.test.js`
Expected: FAIL,`Cannot find module '../gateway/src/store'`

- [ ] **Step 3: 实现**

创建 `gateway/src/store.js`:

```js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_CONFIG = { port: 7081, passwordHash: '', sessionSecret: '' };

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}
function newToken() { return crypto.randomBytes(32).toString('base64url'); }
function newId() { return crypto.randomBytes(6).toString('hex'); }

function defaultDir() {
  return process.env.CCTOWER_GATEWAY_DATA || path.join(os.homedir(), '.cctower-gateway');
}

class Store {
  constructor(dir = defaultDir()) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.serversFile = path.join(dir, 'servers.json');
    this.configFile = path.join(dir, 'config.json');
  }

  // 坏文件不能让网关起不来:此刻能连上的隧道比历史记录更重要
  _read(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }
  // 先写临时文件再 rename:断电/并发也不会留下半截 JSON
  _write(file, data) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  listServers() {
    const v = this._read(this.serversFile, []);
    return Array.isArray(v) ? v : [];
  }

  addServer(name) {
    const servers = this.listServers();
    const token = newToken();
    const server = {
      id: newId(),
      name: String(name || '').trim() || '未命名服务器',
      tokenHash: tokenHash(token),
      addedAt: new Date().toISOString(),
      lastSeenAt: null,
    };
    servers.push(server);
    this._write(this.serversFile, servers);
    return { server, token };
  }

  removeServer(id) {
    const servers = this.listServers();
    const next = servers.filter((s) => s.id !== id);
    if (next.length === servers.length) return false;
    this._write(this.serversFile, next);
    return true;
  }

  findByToken(token) {
    const t = String(token || '');
    if (!t) return null;
    const want = Buffer.from(tokenHash(t), 'utf8');
    for (const s of this.listServers()) {
      const got = Buffer.from(String(s.tokenHash || ''), 'utf8');
      if (got.length === want.length && crypto.timingSafeEqual(got, want)) return s;
    }
    return null;
  }

  touch(id) {
    const servers = this.listServers();
    const s = servers.find((x) => x.id === id);
    if (!s) return;
    s.lastSeenAt = new Date().toISOString();
    this._write(this.serversFile, servers);
  }

  getConfig() {
    const v = this._read(this.configFile, {});
    return { ...DEFAULT_CONFIG, ...(v && typeof v === 'object' ? v : {}) };
  }

  setConfig(patch) {
    const next = { ...this.getConfig(), ...(patch || {}) };
    this._write(this.configFile, next);
    return next;
  }

  // 会话密钥必须跨重启稳定,否则网关一重启所有人都被登出
  ensureSecret() {
    const cfg = this.getConfig();
    if (cfg.sessionSecret) return cfg.sessionSecret;
    const secret = crypto.randomBytes(32).toString('base64');
    this.setConfig({ sessionSecret: secret });
    return secret;
  }
}

module.exports = { Store, tokenHash, newToken };
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `node --test test/gateway-store.test.js`
Expected: PASS(8 tests)

- [ ] **Step 5: 提交**

```bash
git add gateway/src/store.js test/gateway-store.test.js
git commit -s -m "feat(gateway): 服务器注册表与配置存储"
```

---

### Task 4: 网关认证(密码、会话、限速)

**Files:**
- Create: `gateway/src/auth.js`
- Test: `test/gateway-auth.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `hashPassword(password) -> 'scrypt$<salt-b64>$<hash-b64>'`、`verifyPassword(password, stored) -> boolean`
  - `signSession(secret, expSec) -> '<payload-b64url>.<sig-b64url>'`、`verifySession(secret, token, nowSec?) -> {exp}|null`
  - `buildCookie(value, { maxAgeSec?, secure? }) -> string`、`clearCookie({ secure? }) -> string`、`parseCookies(header) -> object`
  - `new RateLimiter({ limit?, windowMs?, now? })`,`.allow(key) -> boolean`、`.reset(key)`
  - 常量 `SESSION_COOKIE = 'ccgw_session'`、`SESSION_TTL_SEC = 604800`

**注意:** scrypt 用同步版本(`crypto.scryptSync`,N=16384/r=8/p=1)。它会阻塞事件循环约 50–100ms,但登录是低频操作,而且这点耗时本身就是对暴力破解的额外阻尼。

- [ ] **Step 1: 写失败的测试**

创建 `test/gateway-auth.test.js`:

```js
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
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `node --test test/gateway-auth.test.js`
Expected: FAIL,`Cannot find module '../gateway/src/auth'`

- [ ] **Step 3: 实现**

创建 `gateway/src/auth.js`:

```js
'use strict';
const crypto = require('node:crypto');

const SESSION_COOKIE = 'ccgw_session';
const SESSION_TTL_SEC = 7 * 24 * 3600;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 32;

// 同步 scrypt 会阻塞事件循环 50–100ms。登录是低频操作,这点耗时反而是对暴力破解的阻尼。
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEY_LEN, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let salt, expect;
  try {
    salt = Buffer.from(parts[1], 'base64');
    expect = Buffer.from(parts[2], 'base64');
  } catch { return false; }
  if (salt.length === 0 || expect.length !== KEY_LEN) return false;
  const got = crypto.scryptSync(String(password), salt, KEY_LEN, SCRYPT);
  return crypto.timingSafeEqual(got, expect);
}

function signSession(secret, expSec) {
  const payload = Buffer.from(JSON.stringify({ exp: expSec }), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySession(secret, token, nowSec = Math.floor(Date.now() / 1000)) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expect = crypto.createHmac('sha256', secret).update(parts[0]).digest('base64url');
  const a = Buffer.from(parts[1], 'utf8');
  const b = Buffer.from(expect, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let obj;
  try { obj = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return null; }
  if (!obj || typeof obj.exp !== 'number' || obj.exp <= nowSec) return null;
  return obj;
}

// secure=false 只给本地 http 调试用:浏览器不会存 http 页面下带 Secure 的 cookie
function buildCookie(value, { maxAgeSec = SESSION_TTL_SEC, secure = true } = {}) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=${maxAgeSec}`;
}
function clearCookie({ secure = true } = {}) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=0`;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); }
    catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

// 计所有尝试(不只是失败):成功后调用 reset,正常用户感知不到,暴力破解者一直撞墙
class RateLimiter {
  constructor({ limit = 5, windowMs = 60_000, now = Date.now } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }
  allow(key) {
    const t = this.now();
    const arr = (this.hits.get(key) || []).filter((ts) => t - ts < this.windowMs);
    if (arr.length >= this.limit) { this.hits.set(key, arr); return false; }
    arr.push(t);
    this.hits.set(key, arr);
    return true;
  }
  reset(key) { this.hits.delete(key); }
}

module.exports = {
  hashPassword, verifyPassword, signSession, verifySession,
  buildCookie, clearCookie, parseCookies, RateLimiter,
  SESSION_COOKIE, SESSION_TTL_SEC,
};
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `node --test test/gateway-auth.test.js`
Expected: PASS(9 tests)

- [ ] **Step 5: 提交**

```bash
git add gateway/src/auth.js test/gateway-auth.test.js
git commit -s -m "feat(gateway): 密码哈希、签名会话与登录限速"
```

---

### Task 5: 会话状态归并(移植 watcher)

**Files:**
- Create: `gateway/src/watcher.js`
- Test: `test/gateway-watcher.test.js`

**Interfaces:**
- Consumes: 无(纯函数模块)
- Produces:`ATTENTION: Set`、`createState() -> Map`、`applyMessage(state, serverId, msg) -> {notify, resolved}`、`attentionCount(state, serverId) -> number`、`totalAttention(state) -> number`、`statusCounts(state, serverId) -> {status: count}`、`dropServer(state, serverId)`

**说明:** 逻辑移植自 `desktop/src/core/watcher.js`(ESM),这里转成 CJS 并新增 `statusCounts`(总览页要按状态显示计数)。桌面壳那份保持不动——它跑在 Tauri 里,模块系统不同,强行共用会把两边都拖下水。

- [ ] **Step 1: 写失败的测试**

创建 `test/gateway-watcher.test.js`:

```js
'use strict';
// 与服务端的消息契约见规格:snapshot / session / notify,其余类型(tail 等)一律不解析。
const test = require('node:test');
const assert = require('node:assert');
const {
  createState, applyMessage, attentionCount, totalAttention, statusCounts, dropServer,
} = require('../gateway/src/watcher');

test('snapshot 覆盖该服务器的全部会话', () => {
  const st = createState();
  applyMessage(st, 'a', { type: 'snapshot', sessions: [
    { id: '1', status: 'executing' }, { id: '2', status: 'needs_decision' },
  ] });
  assert.deepEqual(statusCounts(st, 'a'), { executing: 1, needs_decision: 1 });
  applyMessage(st, 'a', { type: 'snapshot', sessions: [{ id: '3', status: 'ready' }] });
  assert.deepEqual(statusCounts(st, 'a'), { ready: 1 }, '旧会话必须被整体替换');
});

test('session 消息增删改单个会话', () => {
  const st = createState();
  applyMessage(st, 'a', { type: 'snapshot', sessions: [{ id: '1', status: 'ready' }] });
  applyMessage(st, 'a', { type: 'session', session: { id: '1', status: 'blocked' } });
  assert.equal(attentionCount(st, 'a'), 1);
  applyMessage(st, 'a', { type: 'session', session: { id: '1', deleted: true } });
  assert.equal(attentionCount(st, 'a'), 0);
});

test('needs_* / blocked / review_ready 计入需注意,其余不计', () => {
  const st = createState();
  applyMessage(st, 'a', { type: 'snapshot', sessions: [
    { id: '1', status: 'needs_decision' }, { id: '2', status: 'needs_permission' },
    { id: '3', status: 'blocked' }, { id: '4', status: 'review_ready' },
    { id: '5', status: 'executing' }, { id: '6', status: 'completed' },
  ] });
  assert.equal(attentionCount(st, 'a'), 4);
});

test('多服务器互不干扰,totalAttention 求和', () => {
  const st = createState();
  applyMessage(st, 'a', { type: 'snapshot', sessions: [{ id: '1', status: 'blocked' }] });
  applyMessage(st, 'b', { type: 'snapshot', sessions: [{ id: '1', status: 'needs_decision' }] });
  assert.equal(totalAttention(st), 2);
  dropServer(st, 'a');
  assert.equal(totalAttention(st), 1);
  assert.deepEqual(statusCounts(st, 'a'), {}, '掉线服务器不再有计数');
});

test('notify 消息带出服务器归属,便于总览高亮', () => {
  const st = createState();
  const r = applyMessage(st, 'aws1', { type: 'notify', id: 's1', name: '会话', reason: 'needs_decision', statusLine: '等你' });
  assert.equal(r.notify.serverId, 'aws1');
  assert.equal(r.notify.sessionId, 's1');
  assert.equal(r.notify.reason, 'needs_decision');
});

test('未知消息类型与畸形消息被安全忽略', () => {
  const st = createState();
  for (const msg of [{ type: 'tail', id: 'x' }, {}, null, { type: 'session' }]) {
    const r = applyMessage(st, 'a', msg);
    assert.deepEqual(r, { notify: null, resolved: [] });
  }
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `node --test test/gateway-watcher.test.js`
Expected: FAIL,`Cannot find module '../gateway/src/watcher'`

- [ ] **Step 3: 实现**

创建 `gateway/src/watcher.js`:

```js
'use strict';
// 与服务端的契约字段见规格"与服务端的契约"节:snapshot / session / notify,
// 其余消息类型(tail 等)一律不解析。逻辑移植自 desktop/src/core/watcher.js(那份是 ESM,
// 跑在 Tauri 里;这里是 CJS,跑在网关里——两套模块系统,复制比强行共用更省事)。
const ATTENTION = new Set(['needs_decision', 'needs_permission', 'blocked', 'review_ready']);

function createState() { return new Map(); }

// resolved:本条消息使哪些会话离开了注意力状态。一期总览不用它,
// 但保留字段是为了二期 Web Push 能据此撤掉已发出的推送。
function applyMessage(state, serverId, msg) {
  if (!state.has(serverId)) state.set(serverId, new Map());
  const sessions = state.get(serverId);
  switch (msg && msg.type) {
    case 'snapshot': {
      const incoming = new Map((msg.sessions || []).map((s) => [s.id, s.status]));
      const resolved = [];
      for (const [id, status] of sessions) {
        if (ATTENTION.has(status) && !ATTENTION.has(incoming.get(id))) resolved.push(id);
      }
      sessions.clear();
      for (const [id, status] of incoming) sessions.set(id, status);
      return { notify: null, resolved };
    }
    case 'session': {
      if (!msg.session) return { notify: null, resolved: [] };
      const { id, deleted, status } = msg.session;
      const wasAttention = ATTENTION.has(sessions.get(id));
      if (deleted) sessions.delete(id);
      else sessions.set(id, status);
      const stillAttention = !deleted && ATTENTION.has(status);
      return { notify: null, resolved: wasAttention && !stillAttention ? [id] : [] };
    }
    case 'notify':
      return {
        notify: { serverId, sessionId: msg.id, name: msg.name, reason: msg.reason, statusLine: msg.statusLine },
        resolved: [],
      };
    default:
      return { notify: null, resolved: [] };
  }
}

function attentionCount(state, serverId) {
  const sessions = state.get(serverId);
  if (!sessions) return 0;
  let n = 0;
  for (const status of sessions.values()) if (ATTENTION.has(status)) n++;
  return n;
}

function totalAttention(state) {
  let n = 0;
  for (const serverId of state.keys()) n += attentionCount(state, serverId);
  return n;
}

function statusCounts(state, serverId) {
  const sessions = state.get(serverId);
  const out = {};
  if (!sessions) return out;
  for (const status of sessions.values()) out[status] = (out[status] || 0) + 1;
  return out;
}

function dropServer(state, serverId) { state.delete(serverId); }

module.exports = { ATTENTION, createState, applyMessage, attentionCount, totalAttention, statusCounts, dropServer };
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `node --test test/gateway-watcher.test.js`
Expected: PASS(6 tests)

- [ ] **Step 5: 提交**

```bash
git add gateway/src/watcher.js test/gateway-watcher.test.js
git commit -s -m "feat(gateway): 会话状态归并(移植 watcher 并增加状态计数)"
```

---

### Task 6: agent 骨架(包定义、配置、退避)

**Files:**
- Create: `agent/package.json`、`agent/src/config.js`、`agent/src/backoff.js`
- Test: `agent/test/config.test.js`、`agent/test/backoff.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `loadConfig(file?) -> {gatewayUrl, token, localPort, localToken}`、`validateConfig(raw) -> 同上`
  - `nextDelay(attempt, {base?, cap?}) -> number`

- [ ] **Step 1: 写失败的测试**

创建 `agent/test/config.test.js`:

```js
'use strict';
// agent 跑在别人的服务器上、由 systemd 拉起,配置错了必须在启动时就用人话报错,
// 而不是连不上以后无声重试到天荒地老。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, validateConfig } = require('../src/config');

test('合法配置:补齐默认端口与空的本机令牌', () => {
  const c = validateConfig({ gatewayUrl: 'wss://cc.example.com/tunnel', token: 'x'.repeat(32) });
  assert.equal(c.localPort, 7080);
  assert.equal(c.localToken, '');
});

test('gatewayUrl 必须是 ws:// 或 wss://', () => {
  for (const url of ['', 'https://x', 'cc.example.com', null]) {
    assert.throws(() => validateConfig({ gatewayUrl: url, token: 'x'.repeat(32) }), /gatewayUrl/);
  }
  assert.doesNotThrow(() => validateConfig({ gatewayUrl: 'ws://127.0.0.1:7081/tunnel', token: 'x'.repeat(32) }));
});

test('token 缺失或过短被拒(短 token 等于没有认证)', () => {
  for (const t of ['', undefined, 'short']) {
    assert.throws(() => validateConfig({ gatewayUrl: 'wss://x/tunnel', token: t }), /token/);
  }
});

test('localPort 必须是 1–65535 的整数', () => {
  for (const p of [0, 70000, 1.5, 'abc']) {
    assert.throws(() => validateConfig({ gatewayUrl: 'wss://x/tunnel', token: 'x'.repeat(32), localPort: p }), /localPort/);
  }
});

test('loadConfig:读文件、坏 JSON、文件不存在各自给出可读报错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-agent-cfg-'));
  const good = path.join(dir, 'good.json');
  fs.writeFileSync(good, JSON.stringify({ gatewayUrl: 'wss://x/tunnel', token: 'y'.repeat(32), localPort: 7080 }));
  assert.equal(loadConfig(good).token, 'y'.repeat(32));

  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{not json');
  assert.throws(() => loadConfig(bad), /不是合法 JSON/);
  assert.throws(() => loadConfig(path.join(dir, 'nope.json')), /读不到配置文件/);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

创建 `agent/test/backoff.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { nextDelay } = require('../src/backoff');

test('退避:从 base 起翻倍,封顶不再增长', () => {
  assert.equal(nextDelay(0), 1000);
  assert.equal(nextDelay(1), 2000);
  assert.equal(nextDelay(2), 4000);
  assert.equal(nextDelay(5), 30000, '32s 应被 30s 上限截断');
  assert.equal(nextDelay(50), 30000);
});

test('退避:可自定义 base 与 cap,负数 attempt 按 0 处理', () => {
  assert.equal(nextDelay(0, { base: 500, cap: 4000 }), 500);
  assert.equal(nextDelay(3, { base: 500, cap: 4000 }), 4000);
  assert.equal(nextDelay(-3), 1000);
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `npm test --prefix agent`
Expected: FAIL,`Cannot find module '../src/config'`

- [ ] **Step 3: 实现**

创建 `agent/package.json`:

```json
{
  "name": "cctower-agent",
  "version": "0.1.0",
  "private": true,
  "description": "CCTower agent:出站连接网关,把隧道流量转发到本机 CCTower",
  "main": "index.js",
  "type": "commonjs",
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node index.js",
    "test": "node --test test/*.test.js"
  },
  "dependencies": {
    "ws": "^8.21.1"
  }
}
```

创建 `agent/src/config.js`:

```js
'use strict';
const fs = require('node:fs');

const DEFAULT_FILE = process.env.CCTOWER_AGENT_CONFIG || '/etc/cctower-agent.json';

function validateConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const gatewayUrl = String(c.gatewayUrl || '').trim();
  if (!/^wss?:\/\/.+/.test(gatewayUrl)) throw new Error('gatewayUrl 必须以 ws:// 或 wss:// 开头,例如 wss://cc.example.com/tunnel');
  const token = String(c.token || '').trim();
  if (token.length < 16) throw new Error('token 缺失或过短(至少 16 字符),请用 gateway/cli.js add-server 生成');
  const localPort = c.localPort === undefined || c.localPort === null || c.localPort === '' ? 7080 : Number(c.localPort);
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error('localPort 必须是 1–65535 的整数');
  // 只有本机 CCTower 设了 CCW_TOKEN 才需要填;回环默认形态下留空即可
  const localToken = c.localToken === undefined || c.localToken === null ? '' : String(c.localToken);
  return { gatewayUrl, token, localPort, localToken };
}

function loadConfig(file = DEFAULT_FILE) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { throw new Error(`读不到配置文件 ${file}`); }
  let raw;
  try { raw = JSON.parse(text); }
  catch { throw new Error(`配置文件不是合法 JSON:${file}`); }
  return validateConfig(raw);
}

module.exports = { loadConfig, validateConfig, DEFAULT_FILE };
```

创建 `agent/src/backoff.js`:

```js
'use strict';
// 网关重启、网络抖动都会让所有 agent 同时断线;指数退避避免它们一起把网关打垮。
function nextDelay(attempt, { base = 1000, cap = 30000 } = {}) {
  const n = Math.max(0, Number(attempt) || 0);
  return Math.min(cap, base * 2 ** n);
}

module.exports = { nextDelay };
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `npm test --prefix agent`
Expected: PASS(7 tests)

- [ ] **Step 5: 提交**

```bash
git add agent/package.json agent/src/config.js agent/src/backoff.js agent/test/config.test.js agent/test/backoff.test.js
git commit -s -m "feat(agent): 包定义、配置校验与退避"
```

---

### Task 7: agent 本机转发

**Files:**
- Create: `agent/src/forward.js`
- Test: `agent/test/forward.test.js`

**Interfaces:**
- Consumes: Task 1 的 `packWsMessage`/`unpackWsMessage`;Task 2 的 `Stream` 形态(`.meta`、`.headers()`、`.write()`、`.end()`、`.fail()`、事件 `data`/`end`/`aborted`)
- Produces: `handleStream(stream, { localPort, localToken, WebSocketImpl? }) -> void`;辅助导出 `localHeaders(headers, opts)`、`wsSubprotocols(localToken)`

**安全要求(必须实现):** 转发给本机 CCTower 之前,必须丢弃 `cookie`(那是网关的会话凭据)、`origin`/`referer`(会触发服务端同源校验)、`host`(改写为 `127.0.0.1:<port>`)、`x-ccw-token` 与 `sec-websocket-protocol`(本机令牌只能由 agent 自己注入),以及全部逐跳头。

- [ ] **Step 1: 写失败的测试**

创建 `agent/test/forward.test.js`:

```js
'use strict';
// 这一层是"隧道 ↔ 本机 CCTower"的翻译官。用真的 http/ws 服务器做对端,
// 因为头部净化和 text/binary 语义这类问题只有在真实协议栈上才暴露。
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { WebSocketServer } = require('ws');
const { handleStream, localHeaders, wsSubprotocols } = require('../src/forward');
const { packWsMessage, unpackWsMessage } = require('../../shared/tunnel/frames');

// 冒充 Mux 的 Stream:记录 agent 回传的东西,同时能模拟网关侧的输入
class FakeStream extends EventEmitter {
  constructor(meta) { super(); this.meta = meta; this.sentHeaders = null; this.chunks = []; this.ended = false; this.failure = null; }
  headers(m) { this.sentHeaders = m; }
  write(p) { this.chunks.push(Buffer.from(p)); this.emit('_wrote'); }
  end() { this.ended = true; this.emit('_ended'); }
  fail(m) { this.failure = m; this.emit('_failed'); }
  body() { return Buffer.concat(this.chunks).toString('utf8'); }
  waitFor(evt) { return new Promise((r) => this.once(evt, r)); }
}

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

test('头部净化:cookie/origin/x-ccw-token 被丢弃,host 改写,本机令牌注入', () => {
  const h = localHeaders({
    cookie: 'ccgw_session=secret', origin: 'https://cc.example.com', referer: 'https://cc.example.com/',
    host: 'cc.example.com', 'x-ccw-token': '伪造', connection: 'keep-alive',
    'user-agent': 'test-agent', 'content-type': 'application/json',
  }, { localPort: 7080, localToken: '本机令牌' });
  assert.equal(h.cookie, undefined, '网关会话 cookie 绝不能进本机服务');
  assert.equal(h.origin, undefined);
  assert.equal(h.referer, undefined);
  assert.equal(h.connection, undefined);
  assert.equal(h.host, '127.0.0.1:7080');
  assert.equal(h['x-ccw-token'], '本机令牌', '只认 agent 自己注入的令牌');
  assert.equal(h['user-agent'], 'test-agent', '普通头正常透传');
});

test('没配本机令牌时不注入 x-ccw-token', () => {
  const h = localHeaders({ 'x-ccw-token': '伪造' }, { localPort: 7080, localToken: '' });
  assert.equal(h['x-ccw-token'], undefined);
  assert.deepEqual(wsSubprotocols(''), []);
  assert.deepEqual(wsSubprotocols('abc'), ['ccw.token.' + Buffer.from('abc').toString('base64url')]);
});

test('HTTP 转发:请求到达本机,响应状态/头/体原样回传', async () => {
  let seen = null;
  const srv = http.createServer((req, res) => {
    seen = { method: req.method, url: req.url, headers: req.headers };
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.body = body;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const port = await listen(srv);
  const stream = new FakeStream({ type: 'http', method: 'POST', path: '/api/sessions?x=1', headers: { 'content-type': 'application/json' } });
  handleStream(stream, { localPort: port, localToken: '' });
  stream.emit('data', Buffer.from('{"name":"a"}'));
  stream.emit('end');
  await stream.waitFor('_ended');
  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, '/api/sessions?x=1');
  assert.equal(seen.body, '{"name":"a"}');
  assert.equal(stream.sentHeaders.status, 201);
  assert.equal(stream.sentHeaders.headers['content-type'], 'application/json');
  assert.equal(stream.body(), '{"ok":true}');
  srv.close();
});

test('HTTP 转发:本机端口没人监听时 fail 出错,而不是静默挂起', async () => {
  const stream = new FakeStream({ type: 'http', method: 'GET', path: '/', headers: {} });
  handleStream(stream, { localPort: 1, localToken: '' }); // 1 端口必然连不上
  stream.emit('end');
  await stream.waitFor('_failed');
  assert.ok(stream.failure, '必须把失败原因告诉网关');
});

test('WS 转发:双向消息往返且 text/binary 语义不丢', async () => {
  const srv = http.createServer();
  const wss = new WebSocketServer({ server: srv, path: '/ws/events' });
  wss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary })); // 回声
    ws.send('欢迎');
  });
  const port = await listen(srv);
  const stream = new FakeStream({ type: 'ws', path: '/ws/events' });
  handleStream(stream, { localPort: port, localToken: '' });

  await stream.waitFor('_wrote');
  const first = unpackWsMessage(stream.chunks[0]);
  assert.equal(first.isBinary, false);
  assert.equal(first.data.toString('utf8'), '欢迎');

  stream.emit('data', packWsMessage(Buffer.from([1, 2, 3]), true));
  await stream.waitFor('_wrote');
  const echoed = unpackWsMessage(stream.chunks[stream.chunks.length - 1]);
  assert.equal(echoed.isBinary, true);
  assert.deepEqual(Buffer.from(echoed.data), Buffer.from([1, 2, 3]));

  wss.close(); srv.close();
});

test('WS 转发:本机连不上时 fail,连上前到达的消息不丢(排队后补发)', async () => {
  const srv = http.createServer();
  const wss = new WebSocketServer({ server: srv, path: '/ws/term/1' });
  const got = [];
  wss.on('connection', (ws) => ws.on('message', (d) => got.push(String(d))));
  const port = await listen(srv);

  const stream = new FakeStream({ type: 'ws', path: '/ws/term/1' });
  handleStream(stream, { localPort: port, localToken: '' });
  stream.emit('data', packWsMessage(Buffer.from('抢跑的输入'), false)); // 本机 ws 还没 open
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(got, ['抢跑的输入']);

  const dead = new FakeStream({ type: 'ws', path: '/ws/term/1' });
  handleStream(dead, { localPort: 1, localToken: '' });
  await dead.waitFor('_failed');
  assert.ok(dead.failure);

  wss.close(); srv.close();
});

test('未知流类型直接 fail', () => {
  const stream = new FakeStream({ type: 'ftp' });
  handleStream(stream, { localPort: 7080, localToken: '' });
  assert.match(stream.failure, /未知流类型/);
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `npm test --prefix agent`
Expected: FAIL,`Cannot find module '../src/forward'`

- [ ] **Step 3: 实现**

创建 `agent/src/forward.js`:

```js
'use strict';
const http = require('node:http');
const WebSocket = require('ws');
const { packWsMessage, unpackWsMessage } = require('../../shared/tunnel/frames');

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
// 这几个头绝不能从浏览器透传进本机 CCTower:
// cookie 是网关的会话凭据(泄露即等于把网关账号交出去),origin/referer 会撞上服务端的
// 同源校验,host 必须改写成回环,x-ccw-token 与 ws 子协议只能由 agent 自己注入。
const DROP_REQUEST = new Set(['cookie', 'origin', 'referer', 'host', 'x-ccw-token', 'sec-websocket-protocol', ...HOP_BY_HOP]);

function localHeaders(headers, { localPort, localToken }) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = String(k).toLowerCase();
    if (DROP_REQUEST.has(key)) continue;
    out[key] = v;
  }
  out.host = `127.0.0.1:${localPort}`;
  if (localToken) out['x-ccw-token'] = localToken;
  return out;
}

// 服务端要求 WS 令牌走子协议(见 server/index.js 的 wsTokenFrom),不进 URL
function wsSubprotocols(localToken) {
  if (!localToken) return [];
  return [`ccw.token.${Buffer.from(String(localToken), 'utf8').toString('base64url')}`];
}

function handleHttp(stream, meta, opts) {
  const req = http.request({
    host: '127.0.0.1',
    port: opts.localPort,
    method: meta.method || 'GET',
    path: meta.path || '/',
    headers: localHeaders(meta.headers, opts),
  }, (res) => {
    const headers = {};
    for (const [k, v] of Object.entries(res.headers)) {
      if (!HOP_BY_HOP.has(String(k).toLowerCase())) headers[k] = v;
    }
    stream.headers({ status: res.statusCode, headers });
    res.on('data', (c) => stream.write(c));
    res.on('end', () => stream.end());
    res.on('error', (e) => stream.fail(e.message));
  });
  req.on('error', (e) => stream.fail(`本机请求失败:${e.message}`));
  stream.on('data', (c) => req.write(c));
  stream.on('end', () => req.end());
  stream.on('aborted', () => req.destroy());
}

function handleWs(stream, meta, opts) {
  const Impl = opts.WebSocketImpl || WebSocket;
  const url = `ws://127.0.0.1:${opts.localPort}${meta.path || '/'}`;
  let local;
  try {
    local = new Impl(url, wsSubprotocols(opts.localToken), { headers: { Host: `127.0.0.1:${opts.localPort}` } });
  } catch (e) {
    stream.fail(`本机 WS 连接失败:${e.message}`);
    return;
  }
  // 浏览器的第一个输入常常比本机握手更快到达,丢了就是"打的字没反应"
  const pending = [];
  let open = false;
  local.on('open', () => {
    open = true;
    stream.headers({ open: true });
    for (const m of pending.splice(0)) local.send(m.data, { binary: m.isBinary });
  });
  local.on('message', (data, isBinary) => stream.write(packWsMessage(data, isBinary)));
  local.on('close', () => stream.end());
  local.on('error', (e) => stream.fail(`本机 WS 失败:${e.message}`));
  stream.on('data', (buf) => {
    let m;
    try { m = unpackWsMessage(buf); } catch { return; }
    if (open) local.send(m.data, { binary: m.isBinary });
    else pending.push(m);
  });
  stream.on('end', () => { try { local.close(); } catch { /* 已关 */ } });
  stream.on('aborted', () => { try { local.terminate(); } catch { /* 已关 */ } });
}

function handleStream(stream, opts) {
  const meta = stream.meta || {};
  if (meta.type === 'http') return handleHttp(stream, meta, opts);
  if (meta.type === 'ws') return handleWs(stream, meta, opts);
  return stream.fail(`未知流类型 ${meta.type}`);
}

module.exports = { handleStream, localHeaders, wsSubprotocols };
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `npm test --prefix agent`
Expected: PASS(config 5 + backoff 2 + forward 7 = 14 tests)

- [ ] **Step 5: 提交**

```bash
git add agent/src/forward.js agent/test/forward.test.js
git commit -s -m "feat(agent): 本机 HTTP/WS 转发与请求净化"
```

---

### Task 8: agent 主循环

**Files:**
- Create: `agent/index.js`
- Test: `agent/test/agent.test.js`

**Interfaces:**
- Consumes: Task 2 `Mux`;Task 6 `loadConfig`、`nextDelay`;Task 7 `handleStream`
- Produces: `createAgent(config, { WebSocketImpl?, log?, sweepMs?, deadAfterMs? }) -> { start(), stop(), isConnected() }`;直接 `node agent/index.js` 时读配置并启动

**说明:** agent 侧的死连接判定(45s)刻意比网关侧(30s)宽松——让网关先动手,避免两边同时断开造成来回抖动。

- [ ] **Step 1: 写失败的测试**

创建 `agent/test/agent.test.js`:

```js
'use strict';
// 主循环的价值全在异常路径:连不上要退避重试、断了要自愈、被 stop 之后必须彻底安静。
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createAgent } = require('../index');

// 可控的假 WebSocket:构造即记录,由测试决定何时 open/close/error
class FakeWS extends EventEmitter {
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.readyState = 0;
    this.sent = [];
    FakeWS.instances.push(this);
  }
  send(data, opts) { this.sent.push({ data, binary: !!(opts && opts.binary) }); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.terminated = true; this.close(); }
  open() { this.readyState = 1; this.emit('open'); }
}
FakeWS.instances = [];

const cfg = { gatewayUrl: 'wss://gw/tunnel', token: 'z'.repeat(32), localPort: 7080, localToken: '' };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('start:用 Bearer token 连接网关', async () => {
  FakeWS.instances = [];
  const a = createAgent(cfg, { WebSocketImpl: FakeWS, log: () => {} });
  a.start();
  assert.equal(FakeWS.instances.length, 1);
  assert.equal(FakeWS.instances[0].url, 'wss://gw/tunnel');
  assert.equal(FakeWS.instances[0].opts.headers.Authorization, `Bearer ${cfg.token}`);
  a.stop();
});

test('断线后按退避重连,重连成功计数归零', async () => {
  FakeWS.instances = [];
  const a = createAgent(cfg, { WebSocketImpl: FakeWS, log: () => {}, backoff: { base: 10, cap: 20 } });
  a.start();
  FakeWS.instances[0].open();
  assert.equal(a.isConnected(), true);
  FakeWS.instances[0].close();
  assert.equal(a.isConnected(), false);
  await tick(40);
  assert.equal(FakeWS.instances.length, 2, '应该自动重连');
  FakeWS.instances[1].open();
  assert.equal(a.isConnected(), true);
  a.stop();
});

test('stop 之后不再重连(避免进程退不掉)', async () => {
  FakeWS.instances = [];
  const a = createAgent(cfg, { WebSocketImpl: FakeWS, log: () => {}, backoff: { base: 10, cap: 20 } });
  a.start();
  a.stop();
  FakeWS.instances[0].close();
  await tick(60);
  assert.equal(FakeWS.instances.length, 1, 'stop 后不该再有新连接');
});

test('心跳:超过 deadAfterMs 没收到任何帧就掐断重连', async () => {
  FakeWS.instances = [];
  const a = createAgent(cfg, { WebSocketImpl: FakeWS, log: () => {}, sweepMs: 10, deadAfterMs: 20, backoff: { base: 10, cap: 20 } });
  a.start();
  FakeWS.instances[0].open();
  await tick(80);
  assert.equal(FakeWS.instances[0].terminated, true, '半死连接必须被掐断');
  a.stop();
});

test('收到 ping 自动回 pong;坏帧不打断隧道', async () => {
  FakeWS.instances = [];
  const { encodeControl } = require('../../shared/tunnel/frames');
  const a = createAgent(cfg, { WebSocketImpl: FakeWS, log: () => {} });
  a.start();
  const ws = FakeWS.instances[0];
  ws.open();
  ws.emit('message', Buffer.from('{坏帧'), false);   // 不该抛
  ws.emit('message', encodeControl({ streamId: 0, kind: 'ping' }), false);
  assert.ok(ws.sent.some((m) => String(m.data).includes('pong')), '必须回 pong');
  a.stop();
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `npm test --prefix agent`
Expected: FAIL,`Cannot find module '../index'`

- [ ] **Step 3: 实现**

创建 `agent/index.js`:

```js
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
      stopped = false;
      connect();
      sweepTimer = setInterval(sweep, sweepMs);
      if (sweepTimer.unref) sweepTimer.unref();
    },
    stop() {
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
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `npm test --prefix agent`
Expected: PASS(19 tests)

- [ ] **Step 5: 提交**

```bash
git add agent/index.js agent/test/agent.test.js
git commit -s -m "feat(agent): 连接主循环、退避重连与心跳"
```

---

### Task 9: 网关 Hub(隧道生命周期与聚合)

**Files:**
- Create: `gateway/src/hub.js`
- Test: `test/gateway-hub.test.js`

**Interfaces:**
- Consumes: Task 2 `Mux`;Task 3 `Store`;Task 5 watcher
- Produces:
  - `new Hub({ store, pingIntervalMs?, deadAfterMs?, now?, autoSweep? })`
  - `.attach(server, ws)`(server 为注册表记录)、`.detach(serverId)`、`.isOnline(id) -> boolean`
  - `.open(serverId, meta) -> Stream|null`(离线返回 null)
  - `.overview() -> [{ id, name, online, lastSeenAt, attention, counts, stale }]`
  - `.sweep()`(心跳与死连接清理,供测试直接调用)、`.close()`

- [ ] **Step 1: 写失败的测试**

创建 `test/gateway-hub.test.js`:

```js
'use strict';
// Hub 管着"哪台服务器现在能用"。掉线、重连、被顶替这些事天天发生,
// 每一种都必须让总览立刻说实话。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Store } = require('../gateway/src/store');
const { Hub } = require('../gateway/src/hub');
const { Mux } = require('../shared/tunnel/mux');
const { packWsMessage } = require('../shared/tunnel/frames');

// 内存里互联的一对假 ws:a 发出去的东西异步进 b
function fakePair() {
  const a = new EventEmitter();
  const b = new EventEmitter();
  a.readyState = 1; b.readyState = 1;
  a.send = (d, o) => queueMicrotask(() => b.emit('message', d, !!(o && o.binary)));
  b.send = (d, o) => queueMicrotask(() => a.emit('message', d, !!(o && o.binary)));
  const shut = () => {
    if (a.readyState === 3) return;
    a.readyState = 3; b.readyState = 3;
    queueMicrotask(() => { a.emit('close'); b.emit('close'); });
  };
  a.close = shut; b.close = shut; a.terminate = shut; b.terminate = shut;
  return [a, b];
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-hub-'));
  const store = new Store(dir);
  const { server } = store.addServer('aws1');
  const hub = new Hub({ store, autoSweep: false });
  return { dir, store, server, hub, cleanup: () => { hub.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('未接入时:总览显示离线,open 返回 null', () => {
  const f = fixture();
  const row = f.hub.overview()[0];
  assert.equal(row.online, false);
  assert.equal(row.name, 'aws1');
  assert.equal(f.hub.open(f.server.id, { type: 'http', path: '/' }), null);
  f.cleanup();
});

test('接入后:上线、lastSeenAt 落盘、open 能拿到流', async () => {
  const f = fixture();
  const [gwSide, agentSide] = fakePair();
  const agentMux = new Mux({ send: (p, bin) => agentSide.send(p, { binary: bin }) });
  agentSide.on('message', (d, bin) => agentMux.handleMessage(d, bin));

  f.hub.attach(f.server, gwSide);
  assert.equal(f.hub.isOnline(f.server.id), true);
  assert.ok(f.store.listServers()[0].lastSeenAt, '上线应记录时间');

  const incoming = new Promise((r) => agentMux.once('stream', r));
  const s = f.hub.open(f.server.id, { type: 'http', path: '/api/health' });
  assert.ok(s);
  const remote = await incoming;
  assert.equal(remote.meta.path, '/api/health');
  f.cleanup();
});

test('掉线:总览转离线,在途流收到 aborted', async () => {
  const f = fixture();
  const [gwSide] = fakePair();
  f.hub.attach(f.server, gwSide);
  const s = f.hub.open(f.server.id, { type: 'http', path: '/x' });
  const aborted = new Promise((r) => s.on('aborted', r));
  gwSide.close();
  await aborted;
  await tick();
  assert.equal(f.hub.isOnline(f.server.id), false);
  assert.equal(f.hub.overview()[0].online, false);
  f.cleanup();
});

test('同一服务器重复接入:旧连接被踢,新连接生效', async () => {
  const f = fixture();
  const [old1] = fakePair();
  const [new1] = fakePair();
  let oldClosed = false;
  old1.on('close', () => { oldClosed = true; });
  f.hub.attach(f.server, old1);
  f.hub.attach(f.server, new1);
  await tick();
  assert.equal(oldClosed, true, '旧连接必须被踢掉,否则两条隧道抢同一台机器');
  assert.equal(f.hub.isOnline(f.server.id), true);
  f.cleanup();
});

test('事件订阅:agent 回放 snapshot 后总览出现会话计数', async () => {
  const f = fixture();
  const [gwSide, agentSide] = fakePair();
  const agentMux = new Mux({ send: (p, bin) => agentSide.send(p, { binary: bin }) });
  agentSide.on('message', (d, bin) => agentMux.handleMessage(d, bin));
  // agent 冒充本机 CCTower 的 /ws/events
  agentMux.on('stream', (s) => {
    if (s.meta.path !== '/ws/events') return;
    s.headers({ open: true });
    s.write(packWsMessage(Buffer.from(JSON.stringify({
      type: 'snapshot',
      sessions: [{ id: '1', status: 'needs_decision' }, { id: '2', status: 'executing' }],
    })), false));
  });

  f.hub.attach(f.server, gwSide);
  await tick(30);
  const row = f.hub.overview()[0];
  assert.equal(row.attention, 1);
  assert.deepEqual(row.counts, { needs_decision: 1, executing: 1 });
  assert.equal(row.stale, false, '订阅正常时不应标记数据过期');
  f.cleanup();
});

test('sweep:超时未收到任何帧的隧道被判死并断开', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgw-hub-'));
  const store = new Store(dir);
  const { server } = store.addServer('s');
  let clock = 1_000_000;
  const hub = new Hub({ store, autoSweep: false, deadAfterMs: 1000, now: () => clock });
  const [gwSide] = fakePair();
  hub.attach(server, gwSide);
  clock += 500;
  hub.sweep();
  assert.equal(hub.isOnline(server.id), true, '还没到超时不该断');
  clock += 2000;
  hub.sweep();
  await tick();
  assert.equal(hub.isOnline(server.id), false);
  hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('被删除的服务器:即使隧道还在也不出现在总览里', async () => {
  const f = fixture();
  const [gwSide] = fakePair();
  f.hub.attach(f.server, gwSide);
  f.store.removeServer(f.server.id);
  assert.deepEqual(f.hub.overview(), []);
  f.cleanup();
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `node --test test/gateway-hub.test.js`
Expected: FAIL,`Cannot find module '../gateway/src/hub'`

- [ ] **Step 3: 实现**

创建 `gateway/src/hub.js`:

```js
'use strict';
const { EventEmitter } = require('node:events');
const { Mux } = require('../../shared/tunnel/mux');
const { unpackWsMessage } = require('../../shared/tunnel/frames');
const { createState, applyMessage, attentionCount, statusCounts, dropServer } = require('./watcher');

const EVENTS_PATH = '/ws/events';

class Hub extends EventEmitter {
  constructor({ store, pingIntervalMs = 15_000, deadAfterMs = 30_000, now = Date.now, autoSweep = true } = {}) {
    super();
    this.store = store;
    this.pingIntervalMs = pingIntervalMs;
    this.deadAfterMs = deadAfterMs;
    this.now = now;
    this.state = createState();
    this._tunnels = new Map();
    this._timer = autoSweep ? setInterval(() => this.sweep(), pingIntervalMs) : null;
    if (this._timer && this._timer.unref) this._timer.unref();
  }

  attach(server, ws) {
    // 同一台服务器重复接入(比如 agent 重启后旧连接还没超时):踢掉旧的,以新为准
    const prev = this._tunnels.get(server.id);
    if (prev) {
      this._tunnels.delete(server.id);
      prev.mux.closeAll('被新连接取代');
      try { prev.ws.close(); } catch { /* 已关 */ }
    }

    const mux = new Mux({
      initiator: true,
      send: (payload, isBinary) => { if (ws.readyState === 1) ws.send(payload, { binary: isBinary }); },
    });
    const tunnel = { id: server.id, ws, mux, lastFrameAt: this.now(), eventsStale: true, retryTimer: null };
    this._tunnels.set(server.id, tunnel);

    ws.on('message', (data, isBinary) => {
      tunnel.lastFrameAt = this.now();
      // 坏帧不该拖垮整条隧道
      try { mux.handleMessage(data, isBinary); } catch { /* 忽略这一帧 */ }
    });
    ws.on('close', () => this.detach(server.id));
    ws.on('error', () => { try { ws.close(); } catch { /* 已关 */ } });

    this.store.touch(server.id);
    this._subscribeEvents(tunnel);
    this.emit('online', server.id);
  }

  detach(serverId) {
    const t = this._tunnels.get(serverId);
    if (!t) return;
    this._tunnels.delete(serverId);
    if (t.retryTimer) clearTimeout(t.retryTimer);
    t.mux.closeAll('隧道断开');
    try { t.ws.close(); } catch { /* 已关 */ }
    dropServer(this.state, serverId); // 掉线后旧计数就是谎言,直接清掉
    this.store.touch(serverId);
    this.emit('offline', serverId);
  }

  isOnline(serverId) { return this._tunnels.has(serverId); }

  open(serverId, meta) {
    const t = this._tunnels.get(serverId);
    if (!t) return null;
    return t.mux.open(meta);
  }

  overview() {
    return this.store.listServers().map((s) => {
      const t = this._tunnels.get(s.id);
      return {
        id: s.id,
        name: s.name,
        online: !!t,
        lastSeenAt: s.lastSeenAt,
        attention: attentionCount(this.state, s.id),
        counts: statusCounts(this.state, s.id),
        stale: !t || t.eventsStale,
      };
    });
  }

  sweep() {
    for (const t of [...this._tunnels.values()]) {
      if (this.now() - t.lastFrameAt > this.deadAfterMs) {
        // TCP 没断但对端已经死了(移动网络切换最常见):主动掐断,让 agent 走重连
        try { t.ws.terminate ? t.ws.terminate() : t.ws.close(); } catch { /* 已关 */ }
        this.detach(t.id);
        continue;
      }
      t.mux.sendPing();
    }
  }

  close() {
    if (this._timer) clearInterval(this._timer);
    for (const id of [...this._tunnels.keys()]) this.detach(id);
  }

  // 总览的数据来源:借同一条隧道订阅各机的 /ws/events。
  // 它与代理通道相互独立——订阅挂了只影响卡片计数,页面照样能点进去用。
  _subscribeEvents(tunnel) {
    if (!this._tunnels.has(tunnel.id) || this._tunnels.get(tunnel.id) !== tunnel) return;
    const stream = tunnel.mux.open({ type: 'ws', path: EVENTS_PATH });
    tunnel.eventsStale = true;
    stream.on('headers', () => { tunnel.eventsStale = false; });
    stream.on('data', (buf) => {
      let text;
      try { text = unpackWsMessage(buf).data.toString('utf8'); } catch { return; }
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      const { notify } = applyMessage(this.state, tunnel.id, msg);
      if (notify) this.emit('notify', notify);
    });
    const retry = () => {
      tunnel.eventsStale = true;
      if (!this._tunnels.has(tunnel.id) || this._tunnels.get(tunnel.id) !== tunnel) return;
      tunnel.retryTimer = setTimeout(() => this._subscribeEvents(tunnel), 5000);
      if (tunnel.retryTimer.unref) tunnel.retryTimer.unref();
    };
    stream.on('end', retry);
    stream.on('aborted', retry);
  }
}

module.exports = { Hub };
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `node --test test/gateway-hub.test.js`
Expected: PASS(7 tests)

- [ ] **Step 5: 提交**

```bash
git add gateway/src/hub.js test/gateway-hub.test.js
git commit -s -m "feat(gateway): 隧道生命周期管理与状态聚合"
```

---

### Task 10: 网关代理(HTTP 与 WebSocket)

**Files:**
- Create: `gateway/src/proxy.js`
- Test: `test/gateway-proxy.test.js`

**Interfaces:**
- Consumes: Task 9 `Hub`;Task 1 `packWsMessage`/`unpackWsMessage`
- Produces:
  - `proxyHttp(hub, serverId, req, res, targetPath) -> void`
  - `bridgeWebSocket(hub, serverId, ws, targetPath) -> void`
  - `sanitizeRequestHeaders(headers) -> object`
  - `offlinePage(name) -> string`(502 页面 HTML)

**要求:** 离线时 HTTP 返回 502 且响应体是可读的中文页面;WS 桥接在离线时用 close code 1011 关闭浏览器连接。**gateway 的 `express.json()` 绝不能全局挂载**,否则会吃掉待转发的请求体(这条约束在 Task 11 落实)。

- [ ] **Step 1: 写失败的测试**

创建 `test/gateway-proxy.test.js`:

```js
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

test('HTTP 代理:请求方法/路径/体到达 agent,响应原样回浏览器', async () => {
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
  const r = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}',
  });
  assert.equal(r.status, 201);
  assert.equal(await r.text(), '{"id":"abc"}');
  assert.equal(seenMeta.method, 'POST');
  assert.equal(seenMeta.path, '/api/sessions');
  assert.equal(seenBody, '{"name":"x"}');
  srv.close();
});

test('HTTP 代理:服务器离线返回 502 中文页面', async () => {
  const hub = hubWithAgent(() => {});
  const { srv, port } = await listenOnce((req, res) => proxyHttp(hub, 'off', req, res, req.url));
  const r = await fetch(`http://127.0.0.1:${port}/api/sessions`);
  assert.equal(r.status, 502);
  const text = await r.text();
  assert.match(text, /离线/);
  srv.close();
});

test('HTTP 代理:agent 中途报错且尚未发响应头时,回 502 而不是挂死', async () => {
  const hub = hubWithAgent((s) => s.on('end', () => s.fail('本机 CCTower 没起来')));
  const { srv, port } = await listenOnce((req, res) => proxyHttp(hub, 'srv1', req, res, req.url));
  const r = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(r.status, 502);
  srv.close();
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
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `node --test test/gateway-proxy.test.js`
Expected: FAIL,`Cannot find module '../gateway/src/proxy'`

- [ ] **Step 3: 实现**

创建 `gateway/src/proxy.js`:

```js
'use strict';
const { packWsMessage, unpackWsMessage } = require('../../shared/tunnel/frames');

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
// cookie 是网关自己的会话凭据,不能带去被代理的机器;host/origin 由 agent 重写;
// x-ccw-token 只能由 agent 注入,浏览器不许自带。
const DROP = new Set(['cookie', 'host', 'origin', 'referer', 'x-ccw-token', ...HOP_BY_HOP]);

function sanitizeRequestHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = String(k).toLowerCase();
    if (DROP.has(key)) continue;
    out[key] = v;
  }
  return out;
}

function offlinePage(name) {
  const safe = String(name || '该服务器').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><meta charset="utf-8"><title>服务器离线</title>
<div style="font:16px/1.7 system-ui;padding:48px;max-width:520px;margin:auto;color:#ddd;background:#15171c">
<h2 style="color:#f0a">服务器离线</h2>
<p>${safe} 当前没有连上网关。它上面的 agent 会自动重连,通常几十秒内恢复。</p>
<p><a href="/" style="color:#6cf">返回总览</a></p></div>`;
}

function proxyHttp(hub, serverId, req, res, targetPath) {
  const stream = hub.open(serverId, {
    type: 'http',
    method: req.method,
    path: targetPath || '/',
    headers: sanitizeRequestHeaders(req.headers),
  });
  if (!stream) {
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
    res.end(offlinePage(serverId));
    return;
  }

  let headersSent = false;
  stream.on('headers', (meta) => {
    headersSent = true;
    const headers = {};
    for (const [k, v] of Object.entries((meta && meta.headers) || {})) {
      if (!HOP_BY_HOP.has(String(k).toLowerCase())) headers[k] = v;
    }
    res.writeHead((meta && meta.status) || 200, headers);
  });
  stream.on('data', (chunk) => res.write(chunk));
  stream.on('end', () => res.end());
  stream.on('aborted', () => {
    // 还没发响应头就出事,才有机会告诉用户为什么;已经开始流式回传就只能截断
    if (!headersSent) {
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      res.end(offlinePage(serverId));
    } else {
      res.end();
    }
  });

  req.on('data', (c) => stream.write(c));
  req.on('end', () => stream.end());
  req.on('aborted', () => stream.fail('浏览器断开'));
  res.on('close', () => { if (!res.writableEnded) stream.fail('浏览器断开'); });
}

function bridgeWebSocket(hub, serverId, ws, targetPath) {
  const stream = hub.open(serverId, { type: 'ws', path: targetPath || '/' });
  if (!stream) {
    try { ws.close(1011, '服务器离线'); } catch { /* 已关 */ }
    return;
  }
  ws.on('message', (data, isBinary) => stream.write(packWsMessage(data, isBinary)));
  ws.on('close', () => stream.end());
  ws.on('error', () => stream.fail('浏览器 WS 出错'));
  stream.on('data', (buf) => {
    let m;
    try { m = unpackWsMessage(buf); } catch { return; }
    if (ws.readyState === 1) ws.send(m.data, { binary: m.isBinary });
  });
  stream.on('end', () => { try { ws.close(); } catch { /* 已关 */ } });
  stream.on('aborted', () => { try { ws.close(1011, '隧道中断'); } catch { /* 已关 */ } });
}

module.exports = { proxyHttp, bridgeWebSocket, sanitizeRequestHeaders, offlinePage };
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `node --test test/gateway-proxy.test.js`
Expected: PASS(6 tests)

- [ ] **Step 5: 提交**

```bash
git add gateway/src/proxy.js test/gateway-proxy.test.js
git commit -s -m "feat(gateway): HTTP 代理与 WebSocket 桥接"
```

---

### Task 11: 网关应用组装与页面

**Files:**
- Create: `gateway/src/app.js`、`gateway/index.js`、`gateway/public/login.html`、`gateway/public/overview.html`、`gateway/public/overview.js`、`gateway/public/gateway.css`
- Modify: `package.json`(新增 `gateway` 与 `gateway-cli` 脚本)
- Test: `test/gateway-app.test.js`

**Interfaces:**
- Consumes: Task 3 `Store`、Task 4 auth、Task 9 `Hub`、Task 10 proxy
- Produces: `createApp({ store, hub, secureCookie? }) -> { app, handleUpgrade(req, socket, head) }`

**路由约定(实现必须完全一致):**

| 方法/路径 | 行为 |
|-----------|------|
| `GET /login` | 登录页(免认证) |
| `POST /api/login` | 校验密码,限速 5 次/分钟/IP,成功下发 cookie(免认证) |
| `POST /api/logout` | 清 cookie |
| `GET /` | 总览页 |
| `GET /api/overview` | `{ servers: hub.overview() }` |
| `GET /s/:id` | 301 到 `/s/:id/` |
| `/s/:id/*` | 经隧道代理(任意方法) |
| upgrade `/tunnel` | agent 接入,`Authorization: Bearer <token>` |
| upgrade `/s/:id/...` | 校验会话 cookie 后桥接 WS |

未认证时:`/api/*` 返回 401 JSON,其余 302 到 `/login`。

**关键坑:** `express.json()` 只能挂在 `/api/login` 这一条路由上。全局挂载会吞掉待代理请求的请求体,让创建会话之类的 POST 全部变成空体。

- [ ] **Step 1: 写失败的测试**

创建 `test/gateway-app.test.js`:

```js
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

test('未登录:页面 302 去登录页,API 返回 401 JSON', async () => {
  const g = await boot();
  const page = await fetch(`${g.base}/`, { redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login');
  const api = await fetch(`${g.base}/api/overview`);
  assert.equal(api.status, 401);
  assert.equal((await api.json()).error, 'unauthorized');
  g.cleanup();
});

test('登录页免认证可访问', async () => {
  const g = await boot();
  const r = await fetch(`${g.base}/login`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /密码/);
  g.cleanup();
});

test('登录:密码正确下发 HttpOnly cookie,之后能读总览', async () => {
  const g = await boot();
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
  g.cleanup();
});

test('登录:密码错误返回 401,且不下发 cookie', async () => {
  const g = await boot();
  const r = await fetch(`${g.base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: '猜的' }),
  });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('set-cookie'), null);
  g.cleanup();
});

test('登录限速:同一 IP 连续失败第 6 次直接 429', async () => {
  const g = await boot();
  for (let i = 0; i < 5; i++) await login(g.base, '错的');
  const r = await fetch(`${g.base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: '错的' }),
  });
  assert.equal(r.status, 429);
  g.cleanup();
});

test('伪造 cookie 不被接受', async () => {
  const g = await boot();
  const r = await fetch(`${g.base}/api/overview`, { headers: { cookie: 'ccgw_session=伪造.签名' } });
  assert.equal(r.status, 401);
  g.cleanup();
});

test('登出后 cookie 失效', async () => {
  const g = await boot();
  const { cookie } = await login(g.base);
  const out = await fetch(`${g.base}/api/logout`, { method: 'POST', headers: { cookie } });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  g.cleanup();
});

test('/s/:id 补尾斜杠;离线服务器代理返回 502', async () => {
  const g = await boot();
  const { server } = g.store.addServer('s1');
  const { cookie } = await login(g.base);
  const r1 = await fetch(`${g.base}/s/${server.id}`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(r1.status, 301);
  assert.equal(r1.headers.get('location'), `/s/${server.id}/`);
  const r2 = await fetch(`${g.base}/s/${server.id}/api/health`, { headers: { cookie } });
  assert.equal(r2.status, 502);
  g.cleanup();
});

test('agent 接入 /tunnel:错 token 被拒,对 token 上线', async () => {
  const g = await boot();
  const { server, token } = g.store.addServer('s1');
  const WebSocket = require('ws');
  const wsUrl = g.base.replace('http://', 'ws://') + '/tunnel';

  const denied = await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { headers: { Authorization: 'Bearer 错的' } });
    ws.on('open', () => { ws.close(); resolve(false); });
    ws.on('error', () => resolve(true));
    ws.on('unexpected-response', () => resolve(true));
  });
  assert.equal(denied, true, '错 token 必须连不上');

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` } });
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(g.hub.isOnline(server.id), true);
  g.cleanup();
});

test('未登录不能升级 /s/:id 的 WebSocket', async () => {
  const g = await boot();
  const { server } = g.store.addServer('s1');
  const WebSocket = require('ws');
  const failed = await new Promise((resolve) => {
    const ws = new WebSocket(`${g.base.replace('http://', 'ws://')}/s/${server.id}/ws/events`);
    ws.on('open', () => { ws.close(); resolve(false); });
    ws.on('error', () => resolve(true));
    ws.on('unexpected-response', () => resolve(true));
  });
  assert.equal(failed, true);
  g.cleanup();
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `node --test test/gateway-app.test.js`
Expected: FAIL,`Cannot find module '../gateway/src/app'`

- [ ] **Step 3: 实现**

创建 `gateway/src/app.js`:

```js
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
  // Caddy 在前面,限速要按真实客户端 IP 而不是 127.0.0.1
  app.set('trust proxy', true);
  const secret = store.ensureSecret();
  const limiter = new RateLimiter({ limit: 5, windowMs: 60_000 });

  const sessionOk = (headers) => {
    const token = parseCookies(headers.cookie)[SESSION_COOKIE];
    return !!verifySession(secret, token);
  };

  app.get('/login', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));

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
  app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'overview.html')));
  app.get('/api/overview', (_req, res) => res.json({ servers: hub.overview() }));
  // 不补尾斜杠的话,页面里的相对路径资源会解析到 /s/ 下面去
  app.get('/s/:id', (req, res) => res.redirect(301, `/s/${req.params.id}/`));
  app.use('/s/:id', (req, res) => proxyHttp(hub, req.params.id, req, res, req.url || '/'));
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
```

创建 `gateway/index.js`:

```js
'use strict';
const http = require('node:http');
const { Store } = require('./src/store');
const { Hub } = require('./src/hub');
const { createApp } = require('./src/app');

const store = new Store();
const config = store.getConfig();
if (!config.passwordHash) {
  console.error('还没有设置登录密码。先运行:node gateway/cli.js set-password');
  process.exit(1);
}

// 网关自己只听回环,TLS 与公网入口交给前面的 Caddy(见 deploy/Caddyfile.example)
const PORT = Number(process.env.CCTOWER_GATEWAY_PORT || config.port || 7081);
const HOST = process.env.CCTOWER_GATEWAY_HOST || '127.0.0.1';
// 只在本地 http 调试时设 1;线上走 HTTPS 必须保持 Secure cookie
const secureCookie = process.env.CCTOWER_GATEWAY_INSECURE_COOKIE !== '1';

const hub = new Hub({ store });
const { app, handleUpgrade } = createApp({ store, hub, secureCookie });
const server = http.createServer(app);
server.on('upgrade', handleUpgrade);
server.listen(PORT, HOST, () => console.log(`CCTower 网关已启动:http://${HOST}:${PORT}`));

let shuttingDown = false;
function bye(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`网关收到 ${sig},关闭中`);
  hub.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => bye('SIGTERM'));
process.on('SIGINT', () => bye('SIGINT'));
```

创建 `gateway/public/gateway.css`:

```css
:root {
  --bg: #12141a; --card: #1a1d25; --line: #2a2f3a; --fg: #e6e8ee; --dim: #8b93a5;
  --on: #4ade80; --off: #6b7280; --warn: #fbbf24;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.6 system-ui, -apple-system, "PingFang SC", sans-serif; }
header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--line); }
h1 { font-size: 17px; margin: 0; letter-spacing: .08em; }
button { font: inherit; color: var(--fg); background: #222733; border: 1px solid var(--line); border-radius: 8px; padding: 8px 14px; cursor: pointer; }
button:hover { background: #2a3040; }
main { padding: 16px; display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
.card { display: block; padding: 16px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; color: inherit; text-decoration: none; }
.card:hover { border-color: #3a4152; }
.card.off { opacity: .6; }
.card-top { display: flex; align-items: center; gap: 8px; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--off); flex: none; }
.card.on .dot { background: var(--on); }
.name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge { margin-left: auto; background: var(--warn); color: #241c00; border-radius: 999px; padding: 1px 9px; font-size: 13px; font-weight: 700; }
.meta { color: var(--dim); font-size: 13px; margin-top: 8px; }
.counts { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font-size: 12px; color: var(--dim); border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; }
.empty { color: var(--dim); padding: 24px; }
form.login { max-width: 320px; margin: 15vh auto; padding: 0 20px; }
form.login input { width: 100%; padding: 11px 12px; margin: 12px 0; border-radius: 8px; border: 1px solid var(--line); background: #0f1116; color: var(--fg); font: inherit; }
form.login button { width: 100%; }
.err { color: #f87171; min-height: 22px; font-size: 14px; }
@media (max-width: 600px) { main { grid-template-columns: 1fr; padding: 12px; } }
```

创建 `gateway/public/login.html`:

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 · CCTower 网关</title>
<link rel="stylesheet" href="/gateway.css">
</head>
<body>
<form class="login" id="f">
  <h1>CCTower 网关</h1>
  <input id="pw" type="password" placeholder="密码" autocomplete="current-password" autofocus>
  <div class="err" id="err"></div>
  <button type="submit">登录</button>
</form>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  err.textContent = '';
  const r = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('pw').value }),
  });
  if (r.ok) { location.href = '/'; return; }
  const body = await r.json().catch(() => ({}));
  err.textContent = body.error || '登录失败';
});
</script>
</body>
</html>
```

创建 `gateway/public/overview.html`:

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CCTower 总览</title>
<link rel="stylesheet" href="/gateway.css">
</head>
<body>
<header>
  <h1>CCTOWER · 总览</h1>
  <button id="logout">登出</button>
</header>
<main id="list"><div class="empty">加载中…</div></main>
<script src="/overview.js"></script>
</body>
</html>
```

创建 `gateway/public/overview.js`:

```js
'use strict';
// 一期用 3 秒轮询而不是 WS 推送:总览数据量极小,轮询省掉一整套重连逻辑,
// 手机端切前后台也不会留下僵尸连接。
const STATUS_LABEL = {
  ready: '就绪', executing: '执行中', verifying: '验证中', needs_decision: '需要决策',
  needs_permission: '需要权限', blocked: '阻塞', review_ready: '待审核', completed: '已完成',
  stale: '无进展', terminal_only: '终端', exited: '已退出',
};

function ago(iso) {
  if (!iso) return '从未连接';
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (d < 60) return '刚刚';
  if (d < 3600) return `${d / 60 | 0} 分钟前`;
  if (d < 86400) return `${d / 3600 | 0} 小时前`;
  return `${d / 86400 | 0} 天前`;
}

function card(s) {
  const a = document.createElement('a');
  a.className = `card ${s.online ? 'on' : 'off'}`;
  a.href = `/s/${encodeURIComponent(s.id)}/`;

  const top = document.createElement('div');
  top.className = 'card-top';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = s.name;            // 用 textContent:服务器名是用户输入,拼 HTML 就是 XSS
  top.append(dot, name);
  if (s.attention > 0) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = String(s.attention);
    b.title = '需要你处理的会话数';
    top.append(b);
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = s.online
    ? (s.stale ? '在线 · 状态数据获取中' : '在线')
    : `离线 · 最后在线 ${ago(s.lastSeenAt)}`;

  const counts = document.createElement('div');
  counts.className = 'counts';
  for (const [k, n] of Object.entries(s.counts || {})) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = `${STATUS_LABEL[k] || k} ${n}`;
    counts.append(chip);
  }

  a.append(top, meta, counts);
  return a;
}

async function refresh() {
  let data;
  try {
    const r = await fetch('/api/overview');
    if (r.status === 401) { location.href = '/login'; return; }
    data = await r.json();
  } catch { return; }  // 网络抖动:保留上一屏,下个周期再试

  const list = document.getElementById('list');
  list.textContent = '';
  if (!data.servers.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = '还没有添加服务器。在网关机器上运行:node gateway/cli.js add-server <名字>';
    list.append(e);
    return;
  }
  const total = data.servers.reduce((n, s) => n + s.attention, 0);
  document.title = total ? `(${total}) CCTower 总览` : 'CCTower 总览';
  for (const s of data.servers) list.append(card(s));
}

document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login';
});

refresh();
setInterval(refresh, 3000);
```

修改 `package.json`,在 `scripts` 里加两行(保持其余不变):

```json
    "gateway": "node gateway/index.js",
    "gateway-cli": "node gateway/cli.js",
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `node --test test/gateway-app.test.js`
Expected: PASS(10 tests)

- [ ] **Step 5: 提交**

```bash
git add gateway/src/app.js gateway/index.js gateway/public package.json test/gateway-app.test.js
git commit -s -m "feat(gateway): 应用组装、登录页与聚合总览页"
```

---

### Task 12: 网关 CLI

**Files:**
- Create: `gateway/cli.js`
- Test: `test/gateway-cli.test.js`

**Interfaces:**
- Consumes: Task 3 `Store`、Task 4 `hashPassword`
- Produces: `run(argv, { store, readPassword, out }) -> Promise<number>`(返回退出码);`node gateway/cli.js <cmd>` 直接可用

**命令:** `add-server <name>`、`list-servers`、`remove-server <id>`、`set-password`。

- [ ] **Step 1: 写失败的测试**

创建 `test/gateway-cli.test.js`:

```js
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

test('set-password:写入的是哈希,能被 verifyPassword 验过', async () => {
  const c = ctx();
  const code = await run(['set-password'], { ...c, readPassword: async () => '新密码好长好长' });
  assert.equal(code, 0);
  const hash = c.store.getConfig().passwordHash;
  assert.match(hash, /^scrypt\$/);
  assert.equal(verifyPassword('新密码好长好长', hash), true);
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
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `node --test test/gateway-cli.test.js`
Expected: FAIL,`Cannot find module '../gateway/cli'`

- [ ] **Step 3: 实现**

创建 `gateway/cli.js`:

```js
#!/usr/bin/env node
'use strict';
const readline = require('node:readline');
const { Store } = require('./src/store');
const { hashPassword } = require('./src/auth');

const MIN_PASSWORD = 8;

const USAGE = `用法:node gateway/cli.js <命令>

  add-server <名字>     添加一台服务器,打印接入 token(只显示这一次)
  list-servers          列出所有服务器
  remove-server <id>    删除服务器(等同吊销它的 token,在线隧道会被断开)
  set-password          设置网关登录密码`;

// 密码从 stdin 读,不走命令行参数——参数会留在 shell history 和 ps 输出里
function readPasswordFromStdin() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question('新密码:', (a) => { rl.close(); resolve(a); }));
}

async function run(argv, { store = new Store(), out = console.log, readPassword = readPasswordFromStdin } = {}) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'add-server': {
      const name = (rest[0] || '').trim();
      if (!name) { out('缺少名字。用法:add-server <名字>'); return 1; }
      const { server, token } = store.addServer(name);
      out(`已添加服务器 ${server.name}`);
      out(`  id:    ${server.id}`);
      out(`  token: ${token}`);
      out('');
      out('把它写进那台服务器的 /etc/cctower-agent.json(token 只显示这一次):');
      out(JSON.stringify({ gatewayUrl: 'wss://你的域名/tunnel', token, localPort: 7080 }, null, 2));
      return 0;
    }
    case 'list-servers': {
      const servers = store.listServers();
      if (!servers.length) { out('还没有添加任何服务器。用 add-server <名字> 添加。'); return 0; }
      for (const s of servers) out(`${s.id}  ${s.name}  最后在线:${s.lastSeenAt || '从未'}`);
      return 0;
    }
    case 'remove-server': {
      const id = (rest[0] || '').trim();
      if (!store.removeServer(id)) { out(`没有 id 为 ${id} 的服务器`); return 1; }
      out(`已删除 ${id},它的 token 立即失效`);
      return 0;
    }
    case 'set-password': {
      const pw = String(await readPassword() || '');
      if (pw.length < MIN_PASSWORD) { out(`密码至少 ${MIN_PASSWORD} 个字符`); return 1; }
      store.setConfig({ passwordHash: hashPassword(pw) });
      out('密码已更新,重启网关后生效');
      return 0;
    }
    default:
      out(USAGE);
      return 1;
  }
}

module.exports = { run };

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `node --test test/gateway-cli.test.js`
Expected: PASS(7 tests)

- [ ] **Step 5: 提交**

```bash
git add gateway/cli.js test/gateway-cli.test.js
git commit -s -m "feat(gateway): 命令行工具(添加/列出/删除服务器、设置密码)"
```

---

### Task 13: 前端路径前缀感知

**Files:**
- Create: `public/prefix.js`
- Modify: `public/app.js`(第 48–74 行区域的 `WS_BASE`/`api()`、以及第 1070 行的 `fetch('/api/health')`)、`public/index.html`(第 7–8 行与 129–132 行的资源引用)
- Test: `test/prefix.test.js`

**Interfaces:**
- Consumes: 无
- Produces: 浏览器端全局 `window.CCW_PREFIX`(字符串,直连时为 `''`);Node 端 `require('../public/prefix.js').computePrefix(pathname)`

**为什么这么做:** 网关把每台服务器的 UI 挂在 `/s/<id>/` 下,页面里所有绝对路径(`/api/...`、`/ws/...`、`/style.css`)都会打到网关根上。改造收口在三处 JS(`api()`、两处 `new WebSocket`)与 index.html 的资源引用;直连本机时前缀为空串,行为完全不变。

- [ ] **Step 1: 写失败的测试**

创建 `test/prefix.test.js`:

```js
'use strict';
// 前缀推导错一位,整个页面就会把请求打到网关根上,表现为"页面白屏但网关活着"。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { computePrefix } = require('../public/prefix.js');

test('直连本机:前缀为空串,行为与改造前一致', () => {
  assert.equal(computePrefix('/'), '');
  assert.equal(computePrefix('/index.html'), '');
});

test('网关下挂载:前缀是 /s/<id>', () => {
  assert.equal(computePrefix('/s/abc123/'), '/s/abc123');
  assert.equal(computePrefix('/s/abc123/index.html'), '/s/abc123');
});

test('多级前缀也能正确推导(将来放到子路径下也不怕)', () => {
  assert.equal(computePrefix('/a/b/'), '/a/b');
  assert.equal(computePrefix('/a/b/index.html'), '/a/b');
});

test('app.js 里不再有写死的绝对 API/WS 路径', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(!/fetch\('\/api\//.test(src), "不能再有 fetch('/api/...)");
  assert.ok(/CCW_PREFIX/.test(src), 'app.js 必须使用 CCW_PREFIX');
});

test('index.html 的资源引用全部是相对路径', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const abs = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(abs, [], `这些引用还是绝对路径:${abs.join(', ')}`);
  assert.match(html, /src="prefix\.js/, '必须在 app.js 之前加载 prefix.js');
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `node --test test/prefix.test.js`
Expected: FAIL,`Cannot find module '../public/prefix.js'`

- [ ] **Step 3: 实现**

创建 `public/prefix.js`:

```js
/* 页面挂载路径推导:直连本机是 '',经网关是 '/s/<serverId>'。
   写成浏览器与 Node 双用,是为了让这段容易算错的正则能被单元测试钉住。 */
'use strict';
(function (root) {
  function computePrefix(pathname) {
    // 去掉最后一段(文件名或空的尾斜杠),剩下的就是挂载目录
    return String(pathname || '/').replace(/\/[^/]*$/, '');
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { computePrefix };
  else root.CCW_PREFIX = computePrefix(root.location.pathname);
})(typeof window !== 'undefined' ? window : globalThis);
```

修改 `public/index.html`:第 7–8 行改为相对路径,并在脚本区最前面加载 `prefix.js`:

```html
<link rel="stylesheet" href="vendor/xterm.css">
<link rel="stylesheet" href="style.css?v=31">
```

```html
<script src="vendor/xterm.js"></script>
<script src="vendor/addon-fit.js"></script>
<script src="prefix.js?v=31"></script>
<script src="canvas.js?v=31"></script>
<script src="app.js?v=31"></script>
```

修改 `public/app.js`:

1. 在 `const authToken = ...` 上方新增前缀常量,并改写 `WS_BASE`(原第 51 行):

```js
// 经网关访问时页面挂在 /s/<serverId>/ 下,所有请求都要带上这个前缀;
// 直连本机时它是空串,行为与改造前完全一致。
const PREFIX = (typeof window !== 'undefined' && window.CCW_PREFIX) || '';
```

```js
// WS 协议跟随页面:HTTPS 反代下必须用 wss,否则浏览器按混合内容拦截
const WS_BASE = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${PREFIX}`;
```

2. 改写 `api()`(原第 60–69 行)的第一行:

```js
async function api(path, body) {
  const res = await fetch(PREFIX + path, {
```

3. 改写启动时的健康检查(原第 1070 行):

```js
fetch(PREFIX + '/api/health', { headers: authHeaders() }).then((r) => {
```

`public/canvas.js` 无需改动(其中没有绝对 URL)。

- [ ] **Step 4: 运行测试,确认通过**

Run: `node --test test/prefix.test.js`
Expected: PASS(5 tests)

再跑一次语法检查确认没打错字:

Run: `node --check public/app.js && node --check public/prefix.js`
Expected: 无输出

- [ ] **Step 5: 提交**

```bash
git add public/prefix.js public/app.js public/index.html test/prefix.test.js
git commit -s -m "feat(web): 页面路径前缀感知,支持挂在网关子路径下"
```

---

### Task 14: 端到端与安全回归

**Files:**
- Create: `test/gateway-e2e.test.js`
- Test: 同一文件

**Interfaces:**
- Consumes: 全部前序任务
- Produces: 无(纯测试)

**测什么:** 起真的 `server/index.js` + 真的 agent + 真的网关,走完整链路:登录 → 总览出现在线服务器与会话计数 → 经 `/s/<id>/` 代理调 API → WS 事件透传 → agent 掉线后 502 与卡片离线 → agent 重连后自愈。

**端口约定:** 用 `18980`(CCTower)。刻意避开桌面壳 E2E 用的 18977 与隧道端口池 17080–17999,避免并行测试抢端口。

- [ ] **Step 1: 写失败的测试**

创建 `test/gateway-e2e.test.js`:

```js
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
```

- [ ] **Step 2: 运行测试,确认失败(或暴露集成缺陷)**

Run: `node --test test/gateway-e2e.test.js`
Expected: 首次运行若前序任务都已完成,应当直接 PASS;若失败,失败点就是真正的集成缺陷(不要改测试去迁就实现,除非确认是测试自身写错)。

- [ ] **Step 3: 修复集成缺陷(如有)**

按失败信息定位到具体模块修复。常见问题与排查方向:
- 代理页面 404:检查 Task 11 的 `app.use('/s/:id', ...)` 是否正确拿到 `req.params.id`,以及 `req.url` 是否已被 express 剥掉挂载前缀
- WS 升级失败:检查 `handleUpgrade` 的路径正则与 cookie 校验
- 总览 `stale` 一直为 true:检查 Task 9 `_subscribeEvents` 是否在 agent 侧真的连上了 `/ws/events`(agent 的 `handleWs` 必须在 open 后调 `stream.headers(...)`)

- [ ] **Step 4: 运行完整测试套件**

Run: `npm test`
Expected: 全部 PASS(既有 44 + 本计划新增)

Run: `npm test --prefix agent`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add test/gateway-e2e.test.js
git commit -s -m "test(gateway): 端到端链路与安全回归"
```

---

### Task 15: 部署产物、文档与 CI

**Files:**
- Create: `deploy/cctower-gateway.service`、`deploy/cctower-agent.service`、`deploy/Caddyfile.example`、`agent/install.sh`、`docs/GATEWAY.md`
- Modify: `.github/workflows/ci.yml`、`README.md`

**Interfaces:**
- Consumes: 全部前序任务
- Produces: 可部署的产物与文档

- [ ] **Step 1: 写部署产物**

创建 `deploy/cctower-gateway.service`:

```ini
[Unit]
Description=CCTower 远程访问网关
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/cctower
ExecStart=/usr/bin/node /opt/cctower/gateway/index.js
Environment=NODE_ENV=production
# 只听回环,公网入口与 TLS 交给前面的 Caddy
Environment=CCTOWER_GATEWAY_HOST=127.0.0.1
Restart=always
RestartSec=3
# 数据目录默认在 ~/.cctower-gateway,跟随下面这个用户
User=cctower
Group=cctower
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

创建 `deploy/cctower-agent.service`:

```ini
[Unit]
Description=CCTower agent(出站接入远程访问网关)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/cctower-agent
ExecStart=/usr/bin/node /opt/cctower-agent/index.js
Environment=CCTOWER_AGENT_CONFIG=/etc/cctower-agent.json
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

创建 `deploy/Caddyfile.example`:

```
# 把 cc.example.com 换成你的域名;Caddy 会自动申请与续期证书。
cc.example.com {
	encode zstd gzip
	# WebSocket 与 SSE 需要长连接,别设短的超时
	reverse_proxy 127.0.0.1:7081 {
		flush_interval -1
	}
}
```

创建 `agent/install.sh`(记得 `chmod +x`):

```bash
#!/usr/bin/env bash
# 在一台已经跑着 CCTower 的服务器上安装 agent。
# 用法:sudo ./install.sh wss://cc.example.com/tunnel <token> [本机CCTower端口]
set -euo pipefail

GATEWAY_URL="${1:-}"
TOKEN="${2:-}"
LOCAL_PORT="${3:-7080}"
DEST=/opt/cctower-agent
CONFIG=/etc/cctower-agent.json

if [ -z "$GATEWAY_URL" ] || [ -z "$TOKEN" ]; then
  echo "用法:sudo $0 wss://网关域名/tunnel <token> [本机CCTower端口]" >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "需要 root(要写 /etc 与 systemd 单元)" >&2
  exit 1
fi
command -v node >/dev/null || { echo "没找到 node,请先安装 Node.js 20+" >&2; exit 1; }

SRC="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$DEST"
cp -r "$SRC/index.js" "$SRC/src" "$SRC/package.json" "$DEST/"
# agent 用 require('../shared/tunnel/mux') 引共享代码,所以 shared/ 必须与 $DEST 同级
rm -rf "$(dirname "$DEST")/shared"
cp -r "$SRC/../shared" "$(dirname "$DEST")/shared"
( cd "$DEST" && npm install --omit=dev --no-audit --no-fund )

umask 077
cat > "$CONFIG" <<EOF
{
  "gatewayUrl": "$GATEWAY_URL",
  "token": "$TOKEN",
  "localPort": $LOCAL_PORT,
  "localToken": ""
}
EOF
chmod 600 "$CONFIG"

install -m 644 "$SRC/../deploy/cctower-agent.service" /etc/systemd/system/cctower-agent.service
systemctl daemon-reload
systemctl enable --now cctower-agent
echo "装好了。看状态:systemctl status cctower-agent"
echo "如果本机 CCTower 设了 CCW_TOKEN,把同样的值填进 $CONFIG 的 localToken 后重启服务。"
```

**必须实地验证:** `agent/index.js` 用 `require('../shared/tunnel/mux')` 引共享代码,脚本因此把 `shared/` 复制到 `/opt/shared`(与 `/opt/cctower-agent` 同级)。提交前在本机做一次演练确认解析成立:

```bash
rm -rf /tmp/agent-install-check && mkdir -p /tmp/agent-install-check/opt
cp -r agent /tmp/agent-install-check/opt/cctower-agent
cp -r shared /tmp/agent-install-check/opt/shared
cd /tmp/agent-install-check/opt/cctower-agent && npm install --omit=dev --no-audit --no-fund
node -e "require('/tmp/agent-install-check/opt/cctower-agent/index.js'); console.log('模块解析 OK')"
```
Expected: 打印「模块解析 OK」。若失败,改为把 `shared/` 复制进 `$DEST/shared` 并同步把 agent 里的 require 路径改成 `./shared/tunnel/mux`(同时改 Task 7 的 `../../shared/...`)。

- [ ] **Step 2: 写文档**

创建 `docs/GATEWAY.md`,内容需覆盖:

1. **它解决什么问题**:一个 HTTPS 域名聚合多台服务器,NAT 后的机器也能接入,手机浏览器可用。
2. **架构一图**:浏览器 → Caddy → 网关 → 隧道 → agent → 本机 CCTower(回环)。
3. **部署网关**(在一台有公网 IP、线路好的 VPS 上;国内访问优先港/日/新加坡):
   ```bash
   git clone <repo> /opt/cctower && cd /opt/cctower && npm ci --omit=dev
   node gateway/cli.js set-password
   sudo cp deploy/cctower-gateway.service /etc/systemd/system/
   sudo systemctl enable --now cctower-gateway
   # 配好 Caddyfile 后
   sudo systemctl reload caddy
   ```
4. **添加一台服务器**:
   ```bash
   node gateway/cli.js add-server aws1     # 打印 id 与 token
   # 到那台服务器上:
   sudo ./agent/install.sh wss://cc.example.com/tunnel <token> 7080
   ```
5. **本机开了 CCW_TOKEN 怎么办**:把同值填进 `/etc/cctower-agent.json` 的 `localToken`,重启 `cctower-agent`。
6. **手机使用**:浏览器打开域名 → 登录 → 可"添加到主屏幕";一期是桌面版页面,移动端适配在二期。
7. **排障**:
   - 卡片一直离线 → `systemctl status cctower-agent`、`journalctl -u cctower-agent -n 50`
   - 点进去 502 → agent 在线但本机 CCTower 没起来,查 `curl -I http://127.0.0.1:7080/`
   - 登录后立刻被登出 → 检查是否用 http 访问(Secure cookie 存不下),线上必须走 HTTPS
   - 忘了密码 → `node gateway/cli.js set-password` 重设
8. **安全须知**:唯一公网暴露面是网关 443;各机 CCTower 保持只听回环;删除服务器即吊销其 token;网关数据目录 `~/.cctower-gateway` 权限 0700。

在 `README.md` 里加一节"远程访问(多机聚合)",三五句话说明用途并链接到 `docs/GATEWAY.md`。

- [ ] **Step 3: 更新 CI**

修改 `.github/workflows/ci.yml`:在 `Syntax check entrypoints` 的清单里追加新入口:

```yaml
          node --check gateway/index.js
          node --check gateway/cli.js
          node --check agent/index.js
          node --check public/prefix.js
```

并新增 agent 测试 job:

```yaml
  agent-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci --prefix agent
      - run: npm test --prefix agent
```

(网关与隧道的测试在根 `test/` 里,已由现有 `test` job 覆盖,不必重复建 job。)

- [ ] **Step 4: 验证**

Run: `npm test`
Expected: 全部 PASS

Run: `npm test --prefix agent`
Expected: 全部 PASS

Run: `bash -n agent/install.sh`
Expected: 无输出(语法正确)

Run: `node --check gateway/index.js && node --check gateway/cli.js && node --check agent/index.js && node --check public/prefix.js`
Expected: 无输出

- [ ] **Step 5: 提交**

```bash
chmod +x agent/install.sh
git add deploy agent/install.sh docs/GATEWAY.md README.md .github/workflows/ci.yml
git commit -s -m "chore(gateway): systemd 单元、Caddy 示例、安装脚本、文档与 CI"
```

---

## 自审记录

**规格覆盖:** 规格 §3 架构→Task 1/2/6-11;§4 隧道协议→Task 1/2;§5 agent→Task 6/7/8/15;§6.1 注册表与 CLI→Task 3/12;§6.2 认证→Task 4/11;§6.3 反向代理→Task 10/11;§6.4 聚合总览→Task 9/11;§7 安全模型→Task 4/7/10/11/14;§8 前端改造→Task 13;§9 错误处理→Task 8(重连)/9(心跳与订阅重试)/10(502);§10 测试→各任务 + Task 14;§11 部署交付→Task 15;§12 不做的事在计划中均未出现。

**已知需实现者注意的两点:**
1. Task 11 的 `app.use('/s/:id', ...)` 依赖 express 5 在 `use` 挂载路径中支持 `:param` 并剥离前缀。Task 11 的测试(补尾斜杠 + 502)会直接验证这一点;若该行为不成立,改用 `app.all('/s/:id/*splat', ...)` 并从 `req.params.splat` 拼回路径,测试不变。
2. Task 15 的 `agent/install.sh` 复制 `shared/` 的路径关系必须实地验证(`require('../shared/...')` 要能解析),不要只凭脚本看着对就提交。
