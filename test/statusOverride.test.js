'use strict';
// 手工状态覆盖 + PTY 分辨率调整
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 假 node-pty:记录 resize 调用,不真正起进程
const ptys = [];
function makeFakePty() {
  const p = {
    resized: [], killed: false,
    onData() { }, onExit() { }, write() { },
    resize(cols, rows) { p.resized.push({ cols, rows }); },
    kill() { p.killed = true; },
  };
  ptys.push(p);
  return p;
}
const ptyPath = require.resolve('node-pty');
require.cache[ptyPath] = {
  id: ptyPath, filename: ptyPath, loaded: true,
  exports: { spawn: () => makeFakePty() },
};

const { SessionManager } = require('../server/manager');

const dirs = [];
function newManager(onNotify) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-status-'));
  dirs.push(dataDir);
  const m = new SessionManager({
    dataDir, baseUrl: 'http://127.0.0.1:0',
    onChange: () => { }, onNotify: onNotify || (() => { }), backend: 'pty',
  });
  clearInterval(m._staleTimer);
  return m;
}
// 等挂起的 _save 落完再删夹具目录,否则会打出一串 ENOENT 噪音
test.after(async () => {
  await new Promise((r) => setTimeout(r, 300));
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function mkSession(m) {
  return m.createSession({ type: 'claude', projectDir: os.tmpdir(), command: 'x', isolate: false });
}

test('手工状态压住系统观测,不被自动判定改回去', () => {
  const m = newManager();
  const s = mkSession(m);
  m.setStatusOverride(s.id, 'review_ready');
  assert.equal(s.status, 'review_ready');
  assert.equal(s.statusOverride, 'review_ready');

  m._setStatus(s, 'executing', '看起来在跑'); // 默认来源:系统观测
  assert.equal(s.status, 'review_ready', '系统观测不应覆盖手工状态');
  assert.equal(s.statusLine, '看起来在跑', 'statusLine 仍应更新,便于看到真实进展');

  m._setStatus(s, 'stale', '很久没动静', 'AI 归纳');
  assert.equal(s.status, 'review_ready', 'AI 归纳也不应覆盖');
});

test('Agent 上报可以夺回状态控制权', () => {
  const m = newManager();
  const s = mkSession(m);
  m.setStatusOverride(s.id, 'completed');
  m._setStatus(s, 'verifying', '正在跑测试', 'Agent 上报');
  assert.equal(s.status, 'verifying', 'Agent 上报应打穿手工状态');
  assert.equal(s.statusOverride, null, '打穿后应回到自动判定');
});

test('需要授权 / 决策 / 阻塞 必须打穿手工状态,否则会漏掉必须响应的事', () => {
  for (const st of ['needs_permission', 'needs_decision', 'blocked']) {
    const m = newManager();
    const s = mkSession(m);
    m.setStatusOverride(s.id, 'completed');
    m._setStatus(s, st, '要你处理'); // 来源是系统观测,但注意力状态优先
    assert.equal(s.status, st, `${st} 应打穿手工状态`);
    assert.equal(s.statusOverride, null);
  }
});

test('手工标成注意力状态时不再推送通知(是你自己标的)', () => {
  const hits = [];
  const m = newManager((s, st) => hits.push(st));
  const s = mkSession(m);
  m.setStatusOverride(s.id, 'needs_decision');
  assert.deepEqual(hits, [], '手工标记不应触发通知');
});

test('恢复自动:清掉覆盖后系统观测重新生效', () => {
  const m = newManager();
  const s = mkSession(m);
  m.setStatusOverride(s.id, 'completed');
  m._setStatus(s, 'executing', '在跑');
  assert.equal(s.status, 'completed');

  m.setStatusOverride(s.id, null);
  assert.equal(s.statusOverride, null);
  m._setStatus(s, 'executing', '在跑');
  assert.equal(s.status, 'executing', '恢复自动后应重新跟随系统观测');
});

test('拒绝伪造 exited,以及任何未知状态', () => {
  const m = newManager();
  const s = mkSession(m);
  assert.throws(() => m.setStatusOverride(s.id, 'exited'), /不支持手工设为/);
  assert.throws(() => m.setStatusOverride(s.id, 'bogus'), /不支持手工设为/);
  assert.throws(() => m.setStatusOverride('no-such-id', 'ready'), /session 不存在/);
});

test('PTY 分辨率:改动同时落到 pty 与 headless 镜像,并回写 session', () => {
  const m = newManager();
  const s = mkSession(m);
  const rt = m.runtime.get(s.id);
  assert.equal(s.ptyCols, 120);
  assert.equal(s.ptyRows, 32);

  const out = m.resizePty(s.id, 80, 50);
  assert.deepEqual(out, { ok: true, cols: 80, rows: 50 });
  assert.deepEqual(rt.pty.resized.at(-1), { cols: 80, rows: 50 }, 'PTY 应被 resize');
  assert.equal(rt.head.cols, 80, 'headless 镜像必须跟 PTY 同尺寸,否则 tail 会错行');
  assert.equal(rt.head.rows, 50);
  assert.equal(s.ptyCols, 80);
  assert.equal(s.ptyRows, 50);
});

test('PTY 分辨率:越界与非数字被拒,且不会动到 PTY', () => {
  const m = newManager();
  const s = mkSession(m);
  const rt = m.runtime.get(s.id);
  const before = rt.pty.resized.length;
  assert.throws(() => m.resizePty(s.id, 10, 30), /列数需在/);
  assert.throws(() => m.resizePty(s.id, 500, 30), /列数需在/);
  assert.throws(() => m.resizePty(s.id, 100, 2), /行数需在/);
  assert.throws(() => m.resizePty(s.id, 100, 900), /行数需在/);
  assert.throws(() => m.resizePty(s.id, 'abc', 30), /必须是数字/);
  assert.equal(rt.pty.resized.length, before, '被拒的请求不应触碰 PTY');
  assert.equal(s.ptyCols, 120, '被拒后不应回写尺寸');
});

test('已有客户端持有控制权时拒绝 REST 改分辨率,避免从别人手里改画面', () => {
  const m = newManager();
  const s = mkSession(m);
  const rt = m.runtime.get(s.id);
  rt.controller = { readyState: 1 }; // 模拟有人接管了终端
  assert.throws(() => m.resizePty(s.id, 90, 40), /已有客户端持有控制权/);

  rt.controller = { readyState: 3 }; // 连接已关闭的旧 controller 不算数
  assert.equal(m.resizePty(s.id, 90, 40).ok, true);
});

test('旧版本存下来的会话在载入时补齐新字段,前端不会读到 undefined', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-migrate-'));
  dirs.push(dataDir);
  // 模拟改动之前落盘的 sessions.json:没有 ptyCols / ptyRows / statusOverride
  fs.writeFileSync(path.join(dataDir, 'sessions.json'), JSON.stringify([{
    id: 'old1', name: '旧会话', type: 'claude', status: 'executing', statusLine: 'x',
    projectDir: os.tmpdir(), alive: false, archived: false, events: [], decisions: [],
    createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
  }]));
  const m = new SessionManager({
    dataDir, baseUrl: 'http://127.0.0.1:0', onChange: () => { }, onNotify: () => { }, backend: 'pty',
  });
  clearInterval(m._staleTimer);
  const s = m.sessions.get('old1');
  assert.equal(s.ptyCols, 120, '应补上默认 PTY 列数');
  assert.equal(s.ptyRows, 32, '应补上默认 PTY 行数');
  assert.equal(s.statusOverride, null, 'statusOverride 应为 null 而不是 undefined');
});

const settle = () => new Promise((r) => setTimeout(r, 200)); // headless 终端异步解析

test('screen 是原样视口:边框字符与缩进原封不动,tail 仍是清洗版', async () => {
  const m = newManager();
  const s = mkSession(m);
  const rt = m.runtime.get(s.id);
  // 模拟 Claude Code 那种全屏盒子 UI
  rt.head.write('╭────────────────────────╮\r\n');
  rt.head.write('│  正在编辑 tail.js      │\r\n');
  rt.head.write('│      缩进四格          │\r\n');
  rt.head.write('╰────────────────────────╯\r\n');
  await settle();

  const rec = m.collectTails().find((x) => x.id === s.id);
  assert.ok(rec, '应产出该 session 的画面');

  // 原样视口:边框行、行首 │、长横线、缩进都必须还在
  assert.ok(rec.screen.includes('╭'), 'screen 应保留盒子上边框');
  assert.ok(rec.screen.includes('╰'), 'screen 应保留盒子下边框');
  assert.ok(/─{10,}/.test(rec.screen), 'screen 不该把长横线折叠掉');
  assert.ok(/│\s{2}正在编辑/.test(rec.screen), 'screen 应保留行首竖线与缩进');
  assert.ok(/\s{6}缩进四格/.test(rec.screen), 'screen 不该把连续空格压缩');

  // 清洗版仍然为小卡片服务:边框行被丢掉、长横线被折叠
  assert.ok(!/─{10,}/.test(rec.tail), 'tail 仍应折叠长横线');
  assert.ok(rec.tail.includes('正在编辑 tail.js'), 'tail 应保留正文');
  assert.ok(!/^│/m.test(rec.tail), 'tail 仍应剥掉行首竖线');
});

test('screen 取的是当前视口,不是滚动缓冲的尾巴', async () => {
  const m = newManager();
  const s = mkSession(m);
  const rt = m.runtime.get(s.id);
  const rows = rt.head.rows;
  for (let i = 1; i <= rows + 40; i++) rt.head.write(`line-${i}\r\n`);
  await settle();

  const rec = m.collectTails().find((x) => x.id === s.id);
  const n = rec.screen.split('\n').length;
  assert.ok(n <= rows, `screen 行数不应超过视口 ${rows} 行,实得 ${n}`);
  assert.ok(rec.screen.includes(`line-${rows + 40}`), 'screen 应含最新一行');
  assert.ok(!rec.screen.includes('line-1\n'), 'screen 不该带出已滚出视口的早期内容');
});

test('画面变化以原样屏幕判定:只有边框动了也要推送', async () => {
  const m = newManager();
  const s = mkSession(m);
  const rt = m.runtime.get(s.id);
  rt.head.write('hello\r\n');
  await settle();
  assert.equal(m.collectTails().length, 1, '首次应推送');
  assert.equal(m.collectTails().length, 0, '画面没变不应重复推送');

  // 只写一行纯边框:清洗版会把它整行丢掉,但原样屏幕变了,必须推
  rt.head.write('────────────────\r\n');
  await settle();
  const out = m.collectTails();
  assert.equal(out.length, 1, '只有边框变化也应推送,否则画布该刷时不刷');
  assert.ok(out[0].screen.includes('─'), '推送内容应含那行边框');
});
