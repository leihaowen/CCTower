# CCTower 桌面薄壳(一期)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tauri 2 桌面客户端:托盘常驻、自动维护多台服务器的 SSH 隧道、注意力事件系统通知、主窗口多服务器切换。

**Architecture:** 服务端仅放宽一处回环 Host/Origin 校验,其余零改动。壳的业务逻辑全部是纯 JS 模块(`desktop/src/core/`,零 Tauri 依赖,`node --test` 单测),Tauri 插件适配层(`desktop/src/shell/`)只做薄胶水。每台服务器的 UI 经隧道加载它自己伺服的页面,客户端不打包 CCTower 前端。

**Tech Stack:** Tauri 2(插件:shell / notification / store / http)、vanilla JS + vite、node:test、系统 `ssh`。

**规格:** `docs/superpowers/specs/2026-08-10-desktop-shell-design.md`(以规格为准,本计划是其执行分解)

## Global Constraints

- Node ≥ 20;根仓库保持 CommonJS,`desktop/` 独立 package.json 用 `"type": "module"`
- desktop 测试脚本用 `node --test test/*.test.js`(不带引号,由 shell 展开——带引号的 glob 只有 Node 21+ 自行展开,CI 的 Node 20 不认;裸目录参数在 Node 24 有 MODULE_NOT_FOUND bug)
- 只用 Tauri 2 稳定 API 与官方插件,不用 unstable 特性(multiwebview 等)
- 一切用户可见文案用中文;代码注释风格与根仓库一致(说约束,不说来历)
- ssh 别名必须过白名单正则(防参数注入),argv 中别名前必须有 `--`
- ssh 固定参数:`-o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3`
- 本地端口区间 17080–17999;退避:1s 起步每次翻倍封顶 30s
- 注意力状态集合:`needs_decision / needs_permission / blocked / review_ready`
- 明确不做:安装/升级托管、跳板机/密码/2FA、Windows、打包前端、通知直达会话深链
- 本机(Linux 服务器)无显示环境:GUI 手动验收推迟到 Mac,本机验证止步于 `npm test`、`npx vite build`、`cargo check`

---

### Task 1: 服务端放宽回环 Host/Origin(唯一的服务端改动)

**Files:**
- Modify: `server/authGuard.js`(新增 `isLoopbackHostHeader` 并导出)
- Modify: `server/index.js:26-32`(`isLocalRequest` 接受回环 Host/Origin)
- Test: `test/authGuard.test.js`(追加用例)

**Interfaces:**
- Produces: `isLoopbackHostHeader(host: string): boolean` —— 判断 Host 头/Origin host 是否回环(localhost、`*.localhost`、`127.x.x.x`、`[::1]`,端口任意)

- [ ] **Step 1: 写失败测试**(追加到 `test/authGuard.test.js`)

```js
const { isLoopbackHostHeader } = require('../server/authGuard');

test('isLoopbackHostHeader:任意端口的回环 Host 都放行', () => {
  for (const h of ['127.0.0.1:17081', '127.0.0.1:7080', 'localhost:17999', 'localhost',
    '[::1]:7080', 'tauri.localhost', '127.255.0.1:80']) {
    assert.equal(isLoopbackHostHeader(h), true, h);
  }
});

test('isLoopbackHostHeader:非回环一律拒绝', () => {
  for (const h of ['192.168.1.5:7080', 'evil.com', 'evil.com:7080', '127.0.0.1.evil.com',
    'localhost.evil.com', '', null, undefined, '0.0.0.0:7080', '[::]:7080']) {
    assert.equal(isLoopbackHostHeader(h), false, String(h));
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/authGuard.test.js`
Expected: FAIL,`isLoopbackHostHeader is not a function`

- [ ] **Step 3: 实现**(`server/authGuard.js`)

```js
// Host 头 / Origin host 的回环判定,端口任意。给桌面壳的 SSH 隧道用:
// 隧道本地端口 ≠ 远端端口,Tauri webview 的 Origin 是 tauri://localhost,
// 固定端口白名单两者都会误拒。Host 本就不是网络层认证(见 SECURITY.md),
// 放宽到"任意端口的回环"不改变信任模型。
const LOOPBACK_HEADER_RE = /^(localhost|[a-z0-9-]+\.localhost|127(?:\.\d{1,3}){3}|\[::1\])(:\d{1,5})?$/i;
function isLoopbackHostHeader(host) {
  return LOOPBACK_HEADER_RE.test(String(host || '').trim());
}
```

导出处追加 `isLoopbackHostHeader`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/authGuard.test.js`
Expected: PASS(新增 2 个用例)

- [ ] **Step 5: 接入 `server/index.js`**

`isLocalRequest` 改为(引入处同时从 authGuard 解构 `isLoopbackHostHeader`):

```js
function isLocalRequest(headers) {
  if (!ALLOWED_HOSTS.has(headers.host) && !isLoopbackHostHeader(headers.host)) return false;
  if (headers.origin) {
    try {
      const h = new URL(headers.origin).host;
      return ALLOWED_HOSTS.has(h) || isLoopbackHostHeader(h);
    } catch { return false; }
  }
  return true;
}
```

注意:`new URL('tauri://localhost').host` 是 `localhost`,由回环判定放行。

- [ ] **Step 6: 全量测试 + 提交**

Run: `npm test` → 全部 PASS;`node --check server/index.js`
```bash
git add server/authGuard.js server/index.js test/authGuard.test.js
git commit -m "服务端放宽任意端口回环 Host/Origin,为桌面壳隧道铺路"
```

---

### Task 2: desktop/ Tauri 2 脚手架

**Files:**
- Create: `desktop/`(create-tauri-app vanilla 模板)、`desktop/.gitignore`、`desktop/capabilities` 配置
- Modify: `desktop/package.json`(test 脚本)、`desktop/src-tauri/tauri.conf.json`、`desktop/src-tauri/Cargo.toml`、`desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Produces: 可构建的空应用;`cd desktop && npm test` 跑 `node --test test/`;窗口默认隐藏(`visible: false`,M1 是纯托盘应用)

- [ ] **Step 1: 生成模板**

```bash
cd /home/nimo/ccw
npm create tauri-app@latest desktop -- --template vanilla --manager npm --yes
cd desktop && npm install
```

- [ ] **Step 2: 安装插件依赖(JS 侧 + Rust 侧)**

```bash
npm install @tauri-apps/api @tauri-apps/plugin-shell @tauri-apps/plugin-notification @tauri-apps/plugin-store @tauri-apps/plugin-http
cd src-tauri && cargo add tauri-plugin-shell tauri-plugin-notification tauri-plugin-store tauri-plugin-http && cd ..
```

`src-tauri/src/lib.rs` 的 builder 链上注册四个插件:

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_store::Builder::new().build())
    .plugin(tauri_plugin_http::init())
```

- [ ] **Step 3: 配置 tauri.conf.json 与能力清单**

`tauri.conf.json` 关键项:`identifier: "com.cctower.desktop"`、`productName: "CCTower"`、主窗口 `visible: false`、`app.security.csp: null`(内容区要加载 http://127.0.0.1 页面)。

`src-tauri/capabilities/default.json` 追加权限:

```json
{
  "permissions": [
    "core:default",
    "notification:default",
    "store:default",
    { "identifier": "http:default", "allow": [{ "url": "http://127.0.0.1:*" }] },
    { "identifier": "shell:allow-execute", "allow": [{ "name": "ssh", "cmd": "ssh", "args": true, "sidecar": false }] },
    { "identifier": "shell:allow-spawn", "allow": [{ "name": "ssh", "cmd": "ssh", "args": true, "sidecar": false }] },
    "shell:allow-kill",
    "shell:allow-open"
  ]
}
```

`args: true` 允许任意参数——参数安全由 core 层别名白名单 + `--` 分隔保证(Task 4)。

- [ ] **Step 4: package.json 加测试脚本 + .gitignore**

`desktop/package.json` scripts 增加 `"test": "node --test test/"`;确认 `"type": "module"`。
`desktop/.gitignore`:`node_modules/`、`dist/`、`src-tauri/target/`。
建空目录占位:`mkdir -p src/core src/shell test`。

- [ ] **Step 5: 验证 + 提交**

```bash
cd desktop && npx vite build          # 前端可构建
cd src-tauri && cargo check           # Rust 侧可编译(首次较慢;缺 webkit2gtk 系统依赖时按报错 apt 安装)
cd ../.. && git add desktop && git commit -m "桌面壳脚手架:Tauri 2 + 四插件 + 能力清单"
```

Expected: vite build 与 cargo check 均无错误。`npm test` 此时报"no tests"属正常。

---

### Task 3: core/backoff.js 退避计算

**Files:**
- Create: `desktop/src/core/backoff.js`
- Test: `desktop/test/backoff.test.js`

**Interfaces:**
- Produces: `nextDelay(attempt: number, {base=1000, cap=30000}?): number`

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextDelay } from '../src/core/backoff.js';

test('指数退避:1s 起步翻倍,封顶 30s', () => {
  assert.equal(nextDelay(0), 1000);
  assert.equal(nextDelay(1), 2000);
  assert.equal(nextDelay(4), 16000);
  assert.equal(nextDelay(5), 30000);
  assert.equal(nextDelay(100), 30000); // 大指数不溢出
});

test('attempt 非法时抛错', () => {
  assert.throws(() => nextDelay(-1), RangeError);
  assert.throws(() => nextDelay(1.5), RangeError);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd desktop && npm test`
Expected: FAIL,模块不存在

- [ ] **Step 3: 实现**

```js
// 重连退避:翻倍封顶,不带抖动 —— 单客户端对单服务器,无雷群问题
export function nextDelay(attempt, { base = 1000, cap = 30000 } = {}) {
  if (!Number.isInteger(attempt) || attempt < 0) throw new RangeError('attempt 必须是非负整数');
  return Math.min(base * 2 ** attempt, cap);
}
```

- [ ] **Step 4: 跑测试确认通过**,然后提交

```bash
git add desktop/src/core/backoff.js desktop/test/backoff.test.js
git commit -m "desktop:退避计算模块"
```

---

### Task 4: core/servers.js 服务器配置校验 + ssh argv 构造

**Files:**
- Create: `desktop/src/core/servers.js`
- Test: `desktop/test/servers.test.js`

**Interfaces:**
- Produces:
  - `normalizeServer(input): {id, name, sshAlias, remotePort, token, enabled}`(不合法抛 Error)
  - `sshTunnelArgs(server, localPort): string[]`
  - `sshStartArgs(server): string[]`(一键启动)

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeServer, sshTunnelArgs, sshStartArgs } from '../src/core/servers.js';

test('normalizeServer:合法输入补齐默认值', () => {
  const s = normalizeServer({ sshAlias: 'prod-1' });
  assert.deepEqual(s, { id: 'prod-1', name: 'prod-1', sshAlias: 'prod-1', remotePort: 7080, token: '', enabled: true });
});

test('normalizeServer:拒绝注入形态的别名', () => {
  for (const alias of ['-oProxyCommand=evil', '.hidden', 'a b', 'a;b', '', 'a/b', '别名']) {
    assert.throws(() => normalizeServer({ sshAlias: alias }), /别名不合法/, alias);
  }
});

test('normalizeServer:端口越界拒绝', () => {
  assert.throws(() => normalizeServer({ sshAlias: 'x', remotePort: 0 }));
  assert.throws(() => normalizeServer({ sshAlias: 'x', remotePort: 65536 }));
  assert.throws(() => normalizeServer({ sshAlias: 'x', remotePort: 1.5 }));
});

test('sshTunnelArgs:argv 精确匹配,别名前有 --', () => {
  const s = normalizeServer({ sshAlias: 'prod-1', remotePort: 7080 });
  assert.deepEqual(sshTunnelArgs(s, 17081), [
    '-N', '-L', '17081:127.0.0.1:7080',
    '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '--', 'prod-1',
  ]);
});

test('sshStartArgs:远程一键启动命令(带 keepalive,防远端挂起无限等)', () => {
  const s = normalizeServer({ sshAlias: 'prod-1' });
  assert.deepEqual(sshStartArgs(s), ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '--', 'prod-1', 'systemctl --user start cctower']);
});
```

- [ ] **Step 2: 跑测试确认失败**(`cd desktop && npm test`)

- [ ] **Step 3: 实现**

```js
// ssh 别名白名单:首字符必须是字母数字(挡 -flag 与 .hidden),后续仅 . _ - 与字母数字。
// 这是参数注入的第一道防线,第二道是 argv 里别名前固定加 "--"。
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function normalizeServer(input = {}) {
  const sshAlias = String(input.sshAlias || '').trim();
  if (!ALIAS_RE.test(sshAlias)) {
    throw new Error(`ssh 别名不合法:「${sshAlias}」。仅允许字母数字与 . _ -,且首字符必须是字母数字`);
  }
  const remotePort = Number(input.remotePort ?? 7080);
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    throw new Error(`远端端口不合法:${input.remotePort}`);
  }
  const name = String(input.name || '').trim() || sshAlias;
  return { id: sshAlias, name, sshAlias, remotePort, token: String(input.token || ''), enabled: input.enabled !== false };
}

const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];

export function sshTunnelArgs(server, localPort) {
  return ['-N', '-L', `${localPort}:127.0.0.1:${server.remotePort}`, ...SSH_OPTS, '--', server.sshAlias];
}

export function sshStartArgs(server) {
  // 一次性远程命令也要 keepalive:远端无响应时靠它超时退出,而不是无限挂住。
  // 不带 ExitOnForwardFailure —— 没有端口转发,该选项无意义
  return ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '--', server.sshAlias, 'systemctl --user start cctower'];
}
```

- [ ] **Step 4: 跑测试确认通过**,提交

```bash
git add desktop/src/core/servers.js desktop/test/servers.test.js
git commit -m "desktop:服务器配置校验与 ssh argv 构造(别名白名单防注入)"
```

---

### Task 5: core/ports.js 本地端口分配

**Files:**
- Create: `desktop/src/core/ports.js`
- Test: `desktop/test/ports.test.js`

**Interfaces:**
- Produces: `pickPort(taken: Set<number>, {start=17080, end=17999}?): number`(耗尽抛 Error)

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickPort } from '../src/core/ports.js';

test('pickPort:跳过已占用,取区间内第一个空闲', () => {
  assert.equal(pickPort(new Set()), 17080);
  assert.equal(pickPort(new Set([17080, 17081])), 17082);
});

test('pickPort:区间耗尽抛错', () => {
  const taken = new Set();
  for (let p = 17080; p <= 17999; p++) taken.add(p);
  assert.throws(() => pickPort(taken), /耗尽/);
});
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现**

```js
// 只做确定性的"跳过已占用";真实的 bind 冲突由 tunnel 的退避重试兜底
// (ssh ExitOnForwardFailure 使 bind 失败表现为进程退出 → 换端口重试,见 shell/main.js)
export function pickPort(taken, { start = 17080, end = 17999 } = {}) {
  for (let p = start; p <= end; p++) if (!taken.has(p)) return p;
  throw new Error(`本地端口区间已耗尽(${start}–${end})`);
}
```

- [ ] **Step 4: 确认通过,提交**

```bash
git add desktop/src/core/ports.js desktop/test/ports.test.js
git commit -m "desktop:本地端口分配"
```

---

### Task 6: core/tunnel.js 隧道状态机

**Files:**
- Create: `desktop/src/core/tunnel.js`
- Test: `desktop/test/tunnel.test.js`

**Interfaces:**
- Consumes: `nextDelay`(Task 3)、`sshTunnelArgs`(Task 4)
- Produces: `class Tunnel`,构造参数 `{server, localPort, spawn, probe, onState, delayFn?, setTimer?, clearTimer?}`;方法 `start()/stop()`;属性 `state`。
  - `spawn(args: string[])` 返回 `{kill(), onExit(cb(code)), onStderr(cb(text))}` —— node 与 Tauri 两种适配器都实现这个形状
  - `probe(localPort) → Promise<boolean>`
  - 状态:`idle / connecting / up / server-down / auth-failed / retrying`
  - `onState(state, detail)` 仅在状态变化时回调

- [ ] **Step 1: 写失败测试**(含手动时钟与假子进程)

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { Tunnel } from '../src/core/tunnel.js';

function makeTimers() {
  const q = [];
  return {
    setTimer: (fn, ms) => { const t = { fn, ms }; q.push(t); return t; },
    clearTimer: (t) => { const i = q.indexOf(t); if (i >= 0) q.splice(i, 1); },
    fire: async () => { const t = q.shift(); if (t) await t.fn(); },
    pending: () => q.length,
  };
}

function makeSpawner() {
  const calls = [];
  let child = null;
  return {
    calls,
    spawn: (args) => {
      calls.push(args);
      const cbs = { exit: [], stderr: [] };
      child = {
        killed: false,
        kill: () => { child.killed = true; },
        onExit: (cb) => cbs.exit.push(cb),
        onStderr: (cb) => cbs.stderr.push(cb),
        emitExit: (code) => cbs.exit.forEach((f) => f(code)),
        emitStderr: (s) => cbs.stderr.forEach((f) => f(s)),
      };
      return child;
    },
    child: () => child,
  };
}

function makeTunnel({ probeResults }) {
  const timers = makeTimers();
  const sp = makeSpawner();
  const states = [];
  const t = new Tunnel({
    server: { id: 'a', name: 'a', sshAlias: 'a', remotePort: 7080, token: '', enabled: true },
    localPort: 17080,
    spawn: sp.spawn,
    probe: async () => probeResults.shift() ?? false,
    onState: (s, d) => states.push([s, d]),
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  return { t, timers, sp, states };
}

test('start → connecting,探活成功 → up', async () => {
  const { t, timers, sp, states } = makeTunnel({ probeResults: [true] });
  t.start();
  assert.equal(states[0][0], 'connecting');
  assert.deepEqual(sp.calls[0].slice(0, 3), ['-N', '-L', '17080:127.0.0.1:7080']);
  await timers.fire(); // 第一次探活
  assert.equal(t.state, 'up');
});

test('ssh 活着但连续 3 次探活失败 → server-down;恢复后回 up', async () => {
  const { t, timers } = makeTunnel({ probeResults: [false, false, false, true] });
  t.start();
  await timers.fire(); await timers.fire(); await timers.fire();
  assert.equal(t.state, 'server-down');
  await timers.fire();
  assert.equal(t.state, 'up');
});

test('stderr 含 Permission denied 且进程退出 → auth-failed,不重连', async () => {
  const { t, timers, sp } = makeTunnel({ probeResults: [] });
  t.start();
  sp.child().emitStderr('git@example: Permission denied (publickey).');
  sp.child().emitExit(255);
  assert.equal(t.state, 'auth-failed');
  assert.equal(timers.pending(), 0); // 没有安排重连
  assert.equal(sp.calls.length, 1);
});

test('普通退出 → retrying,退避翻倍后重新 spawn', async () => {
  const { t, timers, sp } = makeTunnel({ probeResults: [] });
  t.start();
  sp.child().emitExit(1);
  assert.equal(t.state, 'retrying');
  await timers.fire(); // 触发重连
  assert.equal(sp.calls.length, 2);
  sp.child().emitExit(1);
  await timers.fire(); // 第二次重连,退避已翻倍
  assert.equal(sp.calls.length, 3);
});

test('stop:杀进程、取消定时器,退出后回 idle 不再重连', async () => {
  const { t, timers, sp } = makeTunnel({ probeResults: [true] });
  t.start();
  await timers.fire();
  assert.equal(t.state, 'up');
  t.stop();
  assert.equal(sp.child().killed, true);
  sp.child().emitExit(0);
  assert.equal(t.state, 'idle');
  assert.equal(timers.pending(), 0);
});
```

- [ ] **Step 2: 跑测试确认失败**(`cd desktop && npm test`)

- [ ] **Step 3: 实现**

```js
import { nextDelay } from './backoff.js';
import { sshTunnelArgs } from './servers.js';

// BatchMode 下认证失败的 stderr 特征。匹配即为终态:重试也不会自己好,
// 需要用户去修 ssh-agent / known_hosts
const AUTH_FAIL_RE = /permission denied|host key verification failed|too many authentication failures/i;
const PROBE_INTERVAL = 2000;
const PROBE_GRACE = 3; // 连续失败此数后才判 server-down,容忍启动瞬间的抖动

export class Tunnel {
  constructor({ server, localPort, spawn, probe, onState, delayFn = nextDelay,
    setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t) }) {
    this.server = server;
    this.localPort = localPort;
    this.state = 'idle';
    this._spawn = spawn; this._probe = probe; this._onState = onState;
    this._delayFn = delayFn; this._setTimer = setTimer; this._clearTimer = clearTimer;
    this._attempt = 0; this._probeFails = 0; this._stderrTail = '';
    this._child = null; this._timer = null; this._stopped = false;
  }

  start() { this._stopped = false; this._launch(); }

  stop() {
    this._stopped = true;
    this._cancelTimer();
    if (this._child) this._child.kill(); // 收尾在 _onChildExit
    else this._set('idle');
  }

  _set(state, detail = '') {
    if (this.state === state) return;
    this.state = state;
    this._onState(state, detail);
  }

  _launch() {
    this._set('connecting');
    this._stderrTail = ''; this._probeFails = 0;
    this._child = this._spawn(sshTunnelArgs(this.server, this.localPort));
    this._child.onStderr((s) => { this._stderrTail = (this._stderrTail + s).slice(-4096); });
    this._child.onExit(() => this._onChildExit());
    this._scheduleProbe();
  }

  _onChildExit() {
    this._child = null;
    this._cancelTimer();
    if (this._stopped) { this._set('idle'); return; }
    if (AUTH_FAIL_RE.test(this._stderrTail)) { this._set('auth-failed', this._stderrTail.trim()); return; }
    const delay = this._delayFn(this._attempt++);
    this._set('retrying', `${delay}ms 后重连`);
    this._timer = this._setTimer(() => this._launch(), delay);
  }

  _scheduleProbe() { this._timer = this._setTimer(() => this._runProbe(), this.state === 'connecting' && this._probeFails === 0 ? 0 : PROBE_INTERVAL); }

  async _runProbe() {
    if (this._stopped || !this._child) return;
    const ok = await this._probe(this.localPort).catch(() => false);
    if (this._stopped || !this._child) return;
    if (ok) { this._attempt = 0; this._probeFails = 0; this._set('up'); }
    else if (++this._probeFails >= PROBE_GRACE) this._set('server-down');
    this._scheduleProbe();
  }

  _cancelTimer() { if (this._timer != null) { this._clearTimer(this._timer); this._timer = null; } }
}
```

注意:探活与重连共用 `_timer` 是安全的——两者互斥(有子进程时只有探活定时,退出后只有重连定时)。

- [ ] **Step 4: 跑测试确认通过**,提交

```bash
git add desktop/src/core/tunnel.js desktop/test/tunnel.test.js
git commit -m "desktop:隧道状态机(探活/退避/认证终态,全注入可测)"
```

---

### Task 7: core/watcher.js WS 消息归约器

**Files:**
- Create: `desktop/src/core/watcher.js`
- Test: `desktop/test/watcher.test.js`

**Interfaces:**
- Produces:
  - `ATTENTION: Set<string>`
  - `createState(): Map`(serverId → Map(sessionId → status))
  - `applyMessage(state, serverId, msg): {notify: object|null}`(就地更新状态表,返回通知副作用)
  - `attentionCount(state, serverId): number`、`totalAttention(state): number`
  - `dropServer(state, serverId): void`(隧道断开时清空该服务器计数)

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, applyMessage, attentionCount, totalAttention, dropServer } from '../src/core/watcher.js';

test('snapshot 初始化全量状态', () => {
  const st = createState();
  applyMessage(st, 'a', { type: 'snapshot', sessions: [
    { id: 's1', status: 'executing' }, { id: 's2', status: 'needs_decision' }] });
  assert.equal(attentionCount(st, 'a'), 1);
});

test('session 消息:更新、删除', () => {
  const st = createState();
  applyMessage(st, 'a', { type: 'session', session: { id: 's1', status: 'blocked' } });
  assert.equal(attentionCount(st, 'a'), 1);
  applyMessage(st, 'a', { type: 'session', session: { id: 's1', status: 'executing' } });
  assert.equal(attentionCount(st, 'a'), 0);
  applyMessage(st, 'a', { type: 'session', session: { id: 's1', deleted: true } });
  assert.equal(st.get('a').size, 0);
});

test('notify 消息透传为通知副作用,其余类型忽略', () => {
  const st = createState();
  const out = applyMessage(st, 'a', { type: 'notify', id: 's1', name: '会话一', reason: '需要决策', statusLine: '等待选择' });
  assert.deepEqual(out.notify, { serverId: 'a', sessionId: 's1', name: '会话一', reason: '需要决策', statusLine: '等待选择' });
  assert.equal(applyMessage(st, 'a', { type: 'tail', id: 's1' }).notify, null);
  assert.equal(applyMessage(st, 'a', { type: '未知' }).notify, null);
});

test('多服务器汇总与断连清零', () => {
  const st = createState();
  applyMessage(st, 'a', { type: 'snapshot', sessions: [{ id: 's1', status: 'blocked' }] });
  applyMessage(st, 'b', { type: 'snapshot', sessions: [{ id: 's1', status: 'review_ready' }, { id: 's2', status: 'needs_permission' }] });
  assert.equal(totalAttention(st), 3);
  dropServer(st, 'b');
  assert.equal(totalAttention(st), 1);
});
```

- [ ] **Step 2: 跑测试确认失败** → **Step 3: 实现**

```js
// 与服务端的契约字段见规格"与服务端的契约"节:snapshot / session / notify,
// 其余消息类型(tail 等)一律不解析
export const ATTENTION = new Set(['needs_decision', 'needs_permission', 'blocked', 'review_ready']);

export function createState() { return new Map(); }

export function applyMessage(state, serverId, msg) {
  if (!state.has(serverId)) state.set(serverId, new Map());
  const sessions = state.get(serverId);
  switch (msg && msg.type) {
    case 'snapshot':
      sessions.clear();
      for (const s of msg.sessions || []) sessions.set(s.id, s.status);
      return { notify: null };
    case 'session':
      if (!msg.session) return { notify: null };
      if (msg.session.deleted) sessions.delete(msg.session.id);
      else sessions.set(msg.session.id, msg.session.status);
      return { notify: null };
    case 'notify':
      return { notify: { serverId, sessionId: msg.id, name: msg.name, reason: msg.reason, statusLine: msg.statusLine } };
    default:
      return { notify: null };
  }
}

export function attentionCount(state, serverId) {
  const sessions = state.get(serverId);
  if (!sessions) return 0;
  let n = 0;
  for (const status of sessions.values()) if (ATTENTION.has(status)) n++;
  return n;
}

export function totalAttention(state) {
  let n = 0;
  for (const serverId of state.keys()) n += attentionCount(state, serverId);
  return n;
}

export function dropServer(state, serverId) { state.delete(serverId); }
```

- [ ] **Step 4: 确认通过,提交**

```bash
git add desktop/src/core/watcher.js desktop/test/watcher.test.js
git commit -m "desktop:WS 消息归约器(snapshot/session/notify → 状态表与通知)"
```

---

### Task 8: core/trayModel.js 托盘菜单模型

**Files:**
- Create: `desktop/src/core/trayModel.js`
- Test: `desktop/test/trayModel.test.js`

**Interfaces:**
- Consumes: `attentionCount`(Task 7)
- Produces: `buildTrayModel(servers, tunnelStates: Map<id,string>, watcherState): {items: [{id, state, attention, label, canBootstrap}], badge: string}`

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrayModel } from '../src/core/trayModel.js';
import { createState, applyMessage } from '../src/core/watcher.js';

const servers = [
  { id: 'a', name: '生产', sshAlias: 'a', remotePort: 7080, token: '', enabled: true },
  { id: 'b', name: '测试', sshAlias: 'b', remotePort: 7080, token: '', enabled: false },
];

test('禁用的服务器不出现;标签含连接状态与待处理数', () => {
  const ws = createState();
  applyMessage(ws, 'a', { type: 'snapshot', sessions: [{ id: 's1', status: 'blocked' }, { id: 's2', status: 'executing' }] });
  const m = buildTrayModel(servers, new Map([['a', 'up']]), ws);
  assert.equal(m.items.length, 1);
  assert.deepEqual(m.items[0], { id: 'a', state: 'up', attention: 1, label: '生产 · 已连接 · 1 待处理', canBootstrap: false });
  assert.equal(m.badge, '1');
});

test('server-down 时可一键启动;无待处理时角标为空串', () => {
  const m = buildTrayModel(servers, new Map([['a', 'server-down']]), createState());
  assert.equal(m.items[0].canBootstrap, true);
  assert.equal(m.items[0].label, '生产 · CCTower 未运行');
  assert.equal(m.badge, '');
});
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现**

```js
import { attentionCount } from './watcher.js';

const STATE_LABEL = {
  idle: '未连接', connecting: '连接中', up: '已连接',
  'server-down': 'CCTower 未运行', 'auth-failed': '密钥不可用', retrying: '重连中',
};

export function buildTrayModel(servers, tunnelStates, watcherState) {
  const items = servers.filter((s) => s.enabled).map((s) => {
    const state = tunnelStates.get(s.id) || 'idle';
    const attention = attentionCount(watcherState, s.id);
    return {
      id: s.id, state, attention,
      label: `${s.name} · ${STATE_LABEL[state] || state}${attention ? ` · ${attention} 待处理` : ''}`,
      canBootstrap: state === 'server-down',
    };
  });
  const total = items.reduce((sum, i) => sum + i.attention, 0);
  return { items, badge: total ? String(total) : '' };
}
```

- [ ] **Step 4: 确认通过,提交**

```bash
git add desktop/src/core/trayModel.js desktop/test/trayModel.test.js
git commit -m "desktop:托盘菜单模型"
```

---

### Task 9: 集成测试——假 ssh 替身跑真子进程

**Files:**
- Create: `desktop/src/node/nodeSpawn.js`(node child_process 适配器,集成测试与 E2E 复用)
- Create: `desktop/test/fixtures/fake-ssh`(可执行 bash 脚本)
- Test: `desktop/test/tunnel.integration.test.js`

**Interfaces:**
- Produces: `nodeSpawn(bin: string): (args) => {kill, onExit, onStderr}` —— 与 Task 6 的 spawn 契约同形状

- [ ] **Step 1: 写 fixture 与失败测试**

`desktop/test/fixtures/fake-ssh`(`chmod +x`):

```bash
#!/usr/bin/env bash
# 假 ssh:行为由 FAKE_SSH_MODE 控制,argv 原样写到 FAKE_SSH_ARGS_FILE 供断言
[ -n "$FAKE_SSH_ARGS_FILE" ] && printf '%s\n' "$@" > "$FAKE_SSH_ARGS_FILE"
case "$FAKE_SSH_MODE" in
  authfail) echo "user@host: Permission denied (publickey)." >&2; exit 255 ;;
  exit1)    exit 1 ;;
  *)        sleep 3600 ;;
esac
```

`desktop/test/tunnel.integration.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tunnel } from '../src/core/tunnel.js';
import { nodeSpawn } from '../src/node/nodeSpawn.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-ssh');
const server = { id: 'a', name: 'a', sshAlias: 'a', remotePort: 7080, token: '', enabled: true };

function waitState(states, want, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (states.includes(want)) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error(`等 ${want} 超时,已见:${states}`)); }
    }, 20);
  });
}

test('真子进程:挂住的 ssh + 探活成功 → up;stop 后回 idle', async () => {
  process.env.FAKE_SSH_MODE = 'hang';
  const states = [];
  const t = new Tunnel({ server, localPort: 17080, spawn: nodeSpawn(FIXTURE),
    probe: async () => true, onState: (s) => states.push(s) });
  t.start();
  await waitState(states, 'up');
  t.stop();
  await waitState(states, 'idle');
});

test('真子进程:认证失败 → auth-failed 终态', async () => {
  process.env.FAKE_SSH_MODE = 'authfail';
  const states = [];
  const t = new Tunnel({ server, localPort: 17080, spawn: nodeSpawn(FIXTURE),
    probe: async () => false, onState: (s) => states.push(s) });
  t.start();
  await waitState(states, 'auth-failed');
  assert.ok(!states.includes('retrying'));
});
```

- [ ] **Step 2: 跑测试确认失败**(nodeSpawn 不存在)

- [ ] **Step 3: 实现 nodeSpawn**

```js
import { spawn } from 'node:child_process';

// 与 shell/sshExec.js 的 Tauri 适配器同契约,供 node 环境(集成测试/E2E)使用
export function nodeSpawn(bin) {
  return (args) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    return {
      kill: () => child.kill('SIGTERM'),
      onExit: (cb) => child.on('exit', (code) => cb(code)),
      onStderr: (cb) => child.stderr.on('data', (d) => cb(String(d))),
    };
  };
}
```

- [ ] **Step 4: 确认通过,提交**

```bash
chmod +x desktop/test/fixtures/fake-ssh
git add desktop/src/node/nodeSpawn.js desktop/test/fixtures/fake-ssh desktop/test/tunnel.integration.test.js
git commit -m "desktop:假 ssh 集成测试(真子进程走完 up/auth-failed/idle)"
```

---

### Task 10: E2E——对真 CCTower 服务端验证 WS 契约与回环放宽

**Files:**
- Test: `desktop/test/contract.e2e.test.js`
- Modify: `desktop/package.json`(devDependency `ws`)

**Interfaces:**
- Consumes: 根仓库 `server/index.js`(spawn 出真实例)、Task 7 的 `applyMessage`

- [ ] **Step 1: 装 devDep 并写失败测试**

```bash
cd desktop && npm install --save-dev ws
```

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import WebSocket from 'ws';
import { createState, applyMessage } from '../src/core/watcher.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 17977;

async function waitHttp(url, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('服务端起不来');
}

test('真服务端:伪造隧道 Host + tauri Origin 仍能连 WS 并拿到 snapshot', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-e2e-'));
  const srv = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, CCW_PORT: String(PORT), CCW_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitHttp(`http://127.0.0.1:${PORT}/`);
    const msg = await new Promise((resolve, reject) => {
      // 模拟隧道场景:Host 端口与服务端端口不同;Origin 是 Tauri webview 的
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/events`, [], {
        headers: { Host: '127.0.0.1:29999', Origin: 'tauri://localhost' },
      });
      ws.on('message', (d) => { resolve(JSON.parse(String(d))); ws.close(); });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('等 snapshot 超时')), 8000);
    });
    assert.equal(msg.type, 'snapshot');
    assert.ok(Array.isArray(msg.sessions));
    const st = createState();
    applyMessage(st, 'e2e', msg); // 契约:归约器能直接消费真实消息
  } finally {
    srv.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试**

Run: `cd desktop && npm test`
Expected: PASS(Task 1 的放宽已合入;若 FAIL 提示 403/连接被销毁,说明 Task 1 未生效,回去查)

- [ ] **Step 3: 提交**

```bash
git add desktop/package.json desktop/package-lock.json desktop/test/contract.e2e.test.js
git commit -m "desktop:E2E 验证 WS 契约与回环 Host/Origin 放宽"
```

---

### Task 11: shell 适配层 + M1 组装(托盘 + 隧道 + 通知)

**Files:**
- Create: `desktop/src/shell/store.js`、`desktop/src/shell/sshExec.js`、`desktop/src/shell/probe.js`、`desktop/src/shell/wsClient.js`、`desktop/src/shell/notify.js`、`desktop/src/shell/tray.js`、`desktop/src/shell/app.js`
- Modify: `desktop/src/main.js`(模板入口改为挂载 shell/app.js)、`desktop/index.html`

**Interfaces:**
- Consumes: Task 3–8 全部 core 模块
- Produces: `startApp()`(app.js)—— M1 完整运行时;窗口保持隐藏,交互全在托盘

薄胶水不写单测(无逻辑可测),验证靠 `npx vite build` + Mac 手动验收(Task 16 清单)。

- [ ] **Step 1: store.js**

```js
import { load } from '@tauri-apps/plugin-store';
import { normalizeServer } from '../core/servers.js';

let store;
async function db() { if (!store) store = await load('servers.json', { autoSave: false }); return store; }

export async function loadServers() {
  const raw = (await (await db()).get('servers')) || [];
  const out = [];
  for (const item of raw) {
    try { out.push(normalizeServer(item)); } catch { /* 损坏条目跳过,不拖垮全部 */ }
  }
  return out;
}

export async function saveServers(list) {
  const s = await db();
  await s.set('servers', list.map(normalizeServer)); // 写入前再过一遍校验
  await s.save();
}
```

- [ ] **Step 2: sshExec.js**

```js
import { Command } from '@tauri-apps/plugin-shell';

// 返回与 core/tunnel.js 的 spawn 契约同形状的适配器
export function tauriSpawn() {
  return (args) => {
    const cmd = Command.create('ssh', args);
    const exitCbs = [], errCbs = [];
    let child = null, wantKill = false;
    cmd.stderr.on('data', (line) => errCbs.forEach((f) => f(String(line))));
    cmd.on('close', (data) => exitCbs.forEach((f) => f(data.code)));
    cmd.spawn().then((c) => { child = c; if (wantKill) c.kill(); });
    return {
      kill: () => { wantKill = true; if (child) child.kill(); },
      onExit: (cb) => exitCbs.push(cb),
      onStderr: (cb) => errCbs.push(cb),
    };
  };
}

// 一键启动等一次性命令:跑完返回 {code, stderr}
export async function sshRun(args) {
  const out = await Command.create('ssh', args).execute();
  return { code: out.code, stderr: out.stderr };
}
```

- [ ] **Step 3: probe.js 与 wsClient.js**

```js
// probe.js —— plugin-http 走 Rust 侧请求,绕开 webview CORS
import { fetch } from '@tauri-apps/plugin-http';

export async function httpProbe(localPort) {
  try {
    const r = await fetch(`http://127.0.0.1:${localPort}/`, { method: 'GET', connectTimeout: 1500 });
    return r.status < 500;
  } catch { return false; }
}
```

```js
// wsClient.js —— webview 原生 WebSocket;断线自动重连(3s 固定间隔,隧道层已有退避)
export function connectEvents({ localPort, token, onMessage, onDown }) {
  const protocols = token ? [`ccw.token.${b64url(token)}`] : [];
  let ws = null, closed = false;
  const open = () => {
    ws = new WebSocket(`ws://127.0.0.1:${localPort}/ws/events`, protocols);
    ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch { /* 非 JSON 忽略 */ } };
    ws.onclose = () => { if (!closed) { onDown(); setTimeout(open, 3000); } };
  };
  open();
  return { close: () => { closed = true; try { ws && ws.close(); } catch { } } };
}

function b64url(s) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
```

- [ ] **Step 4: notify.js 与 tray.js**

```js
// notify.js
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';

export async function ensurePermission() {
  if (await isPermissionGranted()) return true;
  return (await requestPermission()) === 'granted';
}

export function pushNotification({ name, reason, statusLine }) {
  sendNotification({ title: `${name} · ${reason}`, body: statusLine || '' });
}
```

```js
// tray.js —— 从 trayModel 渲染;点服务器项回调 onOpen(id),点启动项回调 onBootstrap(id)
import { TrayIcon } from '@tauri-apps/api/tray';
import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import { defaultWindowIcon } from '@tauri-apps/api/app';
import { exit } from '@tauri-apps/plugin-process';

let tray = null;

export async function updateTray(model, { onOpen, onBootstrap }) {
  const items = [];
  for (const it of model.items) {
    items.push(await MenuItem.new({ id: `open:${it.id}`, text: it.label, action: () => onOpen(it.id) }));
    if (it.canBootstrap) {
      items.push(await MenuItem.new({ id: `boot:${it.id}`, text: `  ↳ 启动 ${it.id} 的 CCTower`, action: () => onBootstrap(it.id) }));
    }
  }
  items.push(await PredefinedMenuItem.new({ item: 'Separator' }));
  items.push(await MenuItem.new({ id: 'quit', text: '退出 CCTower', action: () => exit(0) }));
  const menu = await Menu.new({ items });
  if (!tray) {
    tray = await TrayIcon.new({ icon: await defaultWindowIcon(), menu, tooltip: 'CCTower' });
  } else {
    await tray.setMenu(menu);
  }
  await tray.setTitle(model.badge || null); // macOS:图标旁文字角标;Linux 忽略
}
```

(`@tauri-apps/plugin-process` 需在 Step 6 一并安装注册,能力清单加 `process:allow-exit`。)

- [ ] **Step 5: app.js 主编排 + main.js 入口**

```js
// app.js —— M1 编排:配置 → 隧道 → watcher → 托盘/通知
import { loadServers } from './store.js';
import { tauriSpawn, sshRun } from './sshExec.js';
import { httpProbe } from './probe.js';
import { connectEvents } from './wsClient.js';
import { ensurePermission, pushNotification } from './notify.js';
import { updateTray } from './tray.js';
import { Tunnel } from '../core/tunnel.js';
import { pickPort } from '../core/ports.js';
import { sshStartArgs } from '../core/servers.js';
import { createState, applyMessage, dropServer } from '../core/watcher.js';
import { buildTrayModel } from '../core/trayModel.js';
import { openUrl } from '@tauri-apps/plugin-shell';

const runtime = {
  servers: [],
  tunnels: new Map(),      // id -> Tunnel
  localPorts: new Map(),   // id -> port
  wsConns: new Map(),      // id -> {close}
  tunnelStates: new Map(), // id -> state
  watcher: createState(),
};

export async function startApp() {
  await ensurePermission();
  runtime.servers = await loadServers();
  const taken = new Set();
  for (const server of runtime.servers.filter((s) => s.enabled)) {
    const port = pickPort(taken); taken.add(port);
    runtime.localPorts.set(server.id, port);
    const tunnel = new Tunnel({
      server, localPort: port, spawn: tauriSpawn(), probe: httpProbe,
      onState: (state) => onTunnelState(server, state),
    });
    runtime.tunnels.set(server.id, tunnel);
    tunnel.start();
  }
  await refreshTray();
}

function onTunnelState(server, state) {
  runtime.tunnelStates.set(server.id, state);
  if (state === 'up' && !runtime.wsConns.has(server.id)) {
    runtime.wsConns.set(server.id, connectEvents({
      localPort: runtime.localPorts.get(server.id),
      token: server.token,
      onMessage: (msg) => {
        const { notify } = applyMessage(runtime.watcher, server.id, msg);
        if (notify) pushNotification(notify);
        if (msg.type !== 'tail') refreshTray(); // tail 高频且不影响角标
      },
      onDown: () => { dropServer(runtime.watcher, server.id); refreshTray(); },
    }));
  }
  if (state !== 'up' && state !== 'server-down') {
    const conn = runtime.wsConns.get(server.id);
    if (conn) { conn.close(); runtime.wsConns.delete(server.id); }
    dropServer(runtime.watcher, server.id);
  }
  refreshTray();
}

let trayBusy = false;
async function refreshTray() {
  if (trayBusy) return; trayBusy = true;
  try {
    await updateTray(buildTrayModel(runtime.servers, runtime.tunnelStates, runtime.watcher), {
      onOpen: (id) => openUrl(`http://127.0.0.1:${runtime.localPorts.get(id)}/`), // M1:系统浏览器兜底
      onBootstrap: async (id) => {
        const server = runtime.servers.find((s) => s.id === id);
        const { code, stderr } = await sshRun(sshStartArgs(server));
        if (code !== 0) pushNotification({ name: server.name, reason: '启动失败', statusLine: stderr.slice(0, 200) });
      },
    });
  } finally { trayBusy = false; }
}
```

`desktop/src/main.js` 换成:

```js
import { startApp } from './shell/app.js';
startApp().catch((e) => console.error('启动失败:', e));
```

`desktop/index.html` 清成空壳(M2 再填):`<body></body>` + `<script type="module" src="/src/main.js"></script>`。

- [ ] **Step 6: 补 process 插件**

```bash
cd desktop && npm install @tauri-apps/plugin-process
cd src-tauri && cargo add tauri-plugin-process && cd ..
```

`lib.rs` 加 `.plugin(tauri_plugin_process::init())`;`capabilities/default.json` 加 `"process:allow-exit"`。

- [ ] **Step 7: 验证 + 提交**

```bash
cd desktop && npm test && npx vite build && (cd src-tauri && cargo check)
git add -A desktop && git commit -m "desktop:M1 组装——托盘常驻 + 自动隧道 + 系统通知 + 一键启动"
```

Expected: 测试全过、构建无错。GUI 行为进 Mac 手动验收清单(Task 16)。

---

### Task 12: M1 手工配置入口(servers.json 说明 + 校验命令)

**Files:**
- Create: `desktop/scripts/add-server.mjs`(命令行添加服务器,M2 表单出来前的配置入口)

**Interfaces:**
- Consumes: `normalizeServer`(Task 4)
- Produces: `node scripts/add-server.mjs <sshAlias> [name] [remotePort] [token]` —— 直接写 Tauri store 的 `servers.json`

- [ ] **Step 1: 实现脚本**

```js
// M1 期间的配置入口:绕过 GUI 直接写 Tauri store 文件。
// store 文件位置:macOS ~/Library/Application Support/com.cctower.desktop/servers.json
//               Linux  ~/.config/com.cctower.desktop/servers.json
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizeServer } from '../src/core/servers.js';

const [alias, name, remotePort, token] = process.argv.slice(2);
if (!alias) { console.error('用法:node scripts/add-server.mjs <sshAlias> [name] [remotePort] [token]'); process.exit(1); }

const dir = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'com.cctower.desktop')
  : path.join(os.homedir(), '.config', 'com.cctower.desktop');
const file = path.join(dir, 'servers.json');

let data = { servers: [] };
try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 首次运行 */ }
const next = normalizeServer({ sshAlias: alias, name, remotePort, token });
data.servers = (data.servers || []).filter((s) => s.id !== next.id).concat(next);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(file, JSON.stringify(data, null, 2));
console.log(`已写入 ${file}:`, next);
```

注意:Tauri store 的文件就是普通 JSON,键为顶层 `servers`(与 store.js 的 `get('servers')` 对应)。

- [ ] **Step 2: 验证 + 提交**

```bash
cd desktop && node scripts/add-server.mjs demo-server 演示 7080 && cat ~/.config/com.cctower.desktop/servers.json
node -e "const s=JSON.parse(require('fs').readFileSync(process.env.HOME+'/.config/com.cctower.desktop/servers.json'));if(s.servers[0].id!=='demo-server')process.exit(1)"
node scripts/add-server.mjs demo-server 演示 7080 # 幂等:同 id 覆盖不重复
git add desktop/scripts/add-server.mjs && git commit -m "desktop:M1 命令行配置入口"
```

清理:测试后删掉本机 `~/.config/com.cctower.desktop/servers.json` 里的 demo 条目。

---

### Task 13: M2 主窗口——侧栏 + iframe 切换 + 服务器表单

**Files:**
- Modify: `desktop/index.html`、`desktop/src/shell/app.js`(暴露 runtime 事件)、`desktop/src/shell/tray.js`(onOpen 改为聚焦窗口)
- Create: `desktop/src/shell/mainWindow.js`、`desktop/src/style.css`

**Interfaces:**
- Consumes: Task 11 的 runtime(servers/tunnelStates/localPorts/watcher)、`saveServers`(Task 11 store.js)
- Produces: 主窗口 UI;`showServer(id)` 供托盘/通知路径调用

- [ ] **Step 1: 冒烟验证 iframe 方案(Mac 上执行;无 Mac 时先跳过,标记待验)**

在 Mac 上 `npm run tauri dev`,手动把一个 iframe 指到任一 CCTower 隧道地址,确认:页面加载、xterm 终端可输入、WS 不断。
**如果 WKWebView 拒绝加载 http iframe(混合内容)**,退路是每台服务器一个 `WebviewWindow`(`new WebviewWindow(id, { url: 'http://127.0.0.1:'+port })`,origin 即 http://127.0.0.1,无混合内容问题),侧栏窗口只做列表与聚焦。本任务其余步骤两种路线通用,差异只在 `showServer` 的实现。

- [ ] **Step 2: index.html + style.css**

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>CCTower</title>
  <link rel="stylesheet" href="/src/style.css" />
</head>
<body>
  <aside id="sidebar">
    <div id="server-list"></div>
    <form id="add-form">
      <h3>添加服务器</h3>
      <input name="sshAlias" placeholder="ssh 别名(必填)" required />
      <input name="name" placeholder="显示名(可选)" />
      <input name="remotePort" placeholder="远端端口,默认 7080" />
      <input name="token" placeholder="令牌(服务器设了 CCW_TOKEN 才填)" />
      <button type="submit">添加</button>
      <p id="form-error"></p>
    </form>
  </aside>
  <main id="content"></main>
  <script type="module" src="/src/main.js"></script>
</body>
</html>
```

`src/style.css`:左栏固定 240px、右侧 `#content` 铺满;`.server-row` 含状态点(`.dot-up/.dot-down/.dot-err` 绿/黄/红)、角标 `.badge`;iframe `width:100%;height:100%;border:0`。

- [ ] **Step 3: mainWindow.js**

```js
// 主窗口:侧栏渲染 + iframe 懒创建切换。数据从 app.js 的 runtime 读,
// 变化通过 'ccw:changed' CustomEvent 通知(app.js 在 refreshTray 时一并派发)
import { saveServers, loadServers } from './store.js';
import { normalizeServer, sshStartArgs } from '../core/servers.js';
import { attentionCount } from '../core/watcher.js';
import { sshRun } from './sshExec.js';

const DOT = { up: 'dot-up', 'server-down': 'dot-down', 'auth-failed': 'dot-err' };

export function initMainWindow(runtime, { onServersChanged }) {
  const list = document.getElementById('server-list');
  const content = document.getElementById('content');
  const frames = new Map(); // id -> iframe
  let activeId = null;

  function showServer(id) {
    activeId = id;
    if (!frames.has(id)) {
      const f = document.createElement('iframe');
      f.src = `http://127.0.0.1:${runtime.localPorts.get(id)}/`;
      content.appendChild(f);
      frames.set(id, f);
    }
    for (const [fid, f] of frames) f.style.display = fid === id ? 'block' : 'none';
    render();
  }

  function render() {
    list.textContent = '';
    for (const s of runtime.servers.filter((x) => x.enabled)) {
      const state = runtime.tunnelStates.get(s.id) || 'idle';
      const n = attentionCount(runtime.watcher, s.id);
      const row = document.createElement('div');
      row.className = 'server-row' + (s.id === activeId ? ' active' : '');
      row.innerHTML = `<span class="dot ${DOT[state] || 'dot-idle'}"></span>
        <span class="name"></span>${n ? `<span class="badge">${n}</span>` : ''}`;
      row.querySelector('.name').textContent = s.name;
      row.onclick = () => showServer(s.id);
      if (state === 'server-down') {
        const btn = document.createElement('button');
        btn.textContent = '启动 CCTower';
        btn.onclick = async (e) => {
          e.stopPropagation();
          const { code, stderr } = await sshRun(sshStartArgs(s));
          if (code !== 0) alert(`启动失败:\n${stderr.slice(0, 500)}`);
        };
        row.appendChild(btn);
      }
      list.appendChild(row);
    }
  }

  document.getElementById('add-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const next = normalizeServer(Object.fromEntries(fd.entries()));
      const all = (await loadServers()).filter((s) => s.id !== next.id).concat(next);
      await saveServers(all);
      e.target.reset();
      document.getElementById('form-error').textContent = '';
      onServersChanged(); // app.js 重建该服务器的隧道
    } catch (err) {
      document.getElementById('form-error').textContent = err.message;
    }
  };

  window.addEventListener('ccw:changed', render);
  render();
  return { showServer };
}
```

- [ ] **Step 4: 接线 app.js 与托盘**

app.js 修改:
1. `refreshTray()` 末尾派发 `window.dispatchEvent(new CustomEvent('ccw:changed'))`;
2. `startApp()` 末尾 `const win = initMainWindow(runtime, { onServersChanged: restartServers })`,其中 `restartServers()` 重新 `loadServers()` 并对新增/变更的服务器建隧道;
3. 托盘 `onOpen` 改为:`getCurrentWindow().show()` + `setFocus()` + `win.showServer(id)`(`@tauri-apps/api/window`);
4. `tauri.conf.json` 主窗口尺寸 1280×800,仍 `visible: false`(由托盘/通知唤起);窗口关闭改为隐藏:监听 `onCloseRequested` → `preventDefault()` + `hide()`。

- [ ] **Step 5: 验证 + 提交**

```bash
cd desktop && npm test && npx vite build && (cd src-tauri && cargo check)
git add -A desktop && git commit -m "desktop:M2 主窗口——侧栏切换 + iframe 内容区 + 服务器表单 + 一键启动"
```

GUI 行为(切换、表单、通知点击唤起)记入 Task 16 手动验收清单,Mac 上执行。

---

### Task 14: CI 增加 desktop 单测 job

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: 加 job**(与现有 job 并列;不装 Rust,不跑 tauri build——单测全是纯 node)

```yaml
  desktop-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm ci --prefix desktop
      - run: npm test --prefix desktop
```

注意首层 `npm ci`:E2E 测试(Task 10)要 spawn 根仓库的 `server/index.js`,需要根依赖就绪。

- [ ] **Step 2: 本地等效验证 + 提交**

```bash
rm -rf desktop/node_modules && npm ci --prefix desktop && npm test --prefix desktop
git add .github/workflows/ci.yml && git commit -m "CI:desktop 单测 job"
```

推送后到 GitHub Actions 确认 job 变绿。

---

### Task 15: 桌面构建 workflow(tauri-action)

**Files:**
- Create: `.github/workflows/desktop-release.yml`

- [ ] **Step 1: 写 workflow**(手动触发;产物上传 artifact,不发 release、不签名)

```yaml
name: desktop-release
on:
  workflow_dispatch:

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: macos-latest
          - platform: ubuntu-22.04
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - uses: dtolnay/rust-toolchain@stable
      - name: Linux 系统依赖
        if: startsWith(matrix.platform, 'ubuntu')
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
      - run: npm ci --prefix desktop
      - uses: tauri-apps/tauri-action@v0
        with:
          projectPath: desktop
      - uses: actions/upload-artifact@v4
        with:
          name: cctower-desktop-${{ matrix.platform }}
          path: |
            desktop/src-tauri/target/release/bundle/dmg/*.dmg
            desktop/src-tauri/target/release/bundle/appimage/*.AppImage
            desktop/src-tauri/target/release/bundle/deb/*.deb
```

- [ ] **Step 2: 提交并手动触发一次**

```bash
git add .github/workflows/desktop-release.yml && git commit -m "CI:桌面构建 workflow(手动触发,产物上传 artifact)"
git push origin main
gh workflow run desktop-release && gh run watch
```

Expected: 两个平台产物构建成功并出现在 artifacts。失败按日志修(常见:Linux 缺系统库、图标缺失——模板自带默认图标应可过)。

---

### Task 16: 文档与手动验收清单

**Files:**
- Create: `desktop/README.md`
- Modify: `README.md`(根,加"桌面客户端"一节)、`docs/GETTING_STARTED.md`(第 6 节安全须知补一句:桌面壳经 SSH 隧道访问时无需 token/ALLOWED_HOSTS)

- [ ] **Step 1: desktop/README.md**,内容必须包含:

1. 前置要求:Node ≥20、Rust(rustup)、系统 ssh、目标服务器已在 `~/.ssh/config` 有别名且密钥可用;
2. 开发:`npm install && npm run tauri dev`;构建:`npm run tauri build`;测试:`npm test`;
3. 配置服务器:M2 表单 或 `node scripts/add-server.mjs <alias>`,store 文件路径(两平台);
4. 手动验收清单(Mac → Linux 服务器):
   - [ ] 添加服务器后 30 秒内托盘出现"已连接"
   - [ ] 服务器上停掉 cctower → 托盘变"CCTower 未运行" → 一键启动 → 恢复"已连接"
   - [ ] 断网 30 秒再恢复 → 隧道自动重连,不需要人工干预
   - [ ] 把某会话手工标成"需要决策" → Mac 收到系统通知,托盘角标 +1
   - [ ] 点通知/托盘项 → 主窗口聚焦并显示该服务器页面,终端可输入
   - [ ] 侧栏在两台服务器之间切换,iframe 状态各自保持(不重载)
   - [ ] 删除 ssh-agent 里的密钥 → 该服务器标红"密钥不可用",不无限重试
   - [ ] 退出应用 → `ps aux | grep 'ssh -N'` 无残留隧道进程
5. iframe 混合内容退路说明(Task 13 Step 1 的 WebviewWindow 方案)。

- [ ] **Step 2: 根 README 加一节**(简短:是什么、指向 desktop/README)

- [ ] **Step 3: 全量验证 + 提交**

```bash
npm test && npm test --prefix desktop
git add desktop/README.md README.md docs/GETTING_STARTED.md
git commit -m "docs:桌面客户端说明与手动验收清单"
```

---

## 任务依赖

- Task 1 独立,但必须先于 Task 10(E2E 依赖放宽)
- Task 2 先于 3–13;Task 3/4/5 相互独立;Task 6 依赖 3、4;Task 7 独立;Task 8 依赖 7
- Task 9 依赖 6;Task 10 依赖 1、7;Task 11 依赖 3–8;Task 12 依赖 4;Task 13 依赖 11
- Task 14 依赖 10;Task 15 依赖 2(建议最后);Task 16 收尾

## 计划自审记录

- 规格覆盖:隧道管理器→T4/T5/T6/T9,配置→T4/T11/T12/T13,检测+一键启动→T6(server-down)/T8/T11/T13,watcher→T7/T10/T11,托盘+主窗口→T8/T11/T13,服务端契约→T7/T10,回环放宽→T1,错误处理表→T6(auth-failed/retrying)/T5(端口)/T11(bootstrap stderr),测试策略→T3–T10,发布→T15,里程碑 M1=T11/T12、M2=T13。
- 已知风险:iframe 混合内容(T13 Step 1 冒烟 + WebviewWindow 退路);Tauri tray `setTitle(null)` 清空角标行为按插件文档,若 API 差异按当版本文档调整;本机无显示环境,GUI 验收整体推迟到 Mac(T16 清单)。
- 通知点击"直达服务器"在 Tauri 桌面端仅能做到"激活应用",无点击载荷——规格已把深链列入"明确不做",通知点开后依赖角标指引,符合规格。
