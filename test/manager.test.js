'use strict';
// 会话恢复:hook 捕获 Claude session_id,重启时以 --resume 恢复对话上下文
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 用假 node-pty 替换真实实现:测试只关心 spawn 参数,不真正起进程
const spawnCalls = [];
function makeFakePty() {
  return {
    onData() { }, onExit() { },
    write() { }, resize() { }, kill() { },
  };
}
const ptyPath = require.resolve('node-pty');
require.cache[ptyPath] = {
  id: ptyPath, filename: ptyPath, loaded: true,
  exports: { spawn: (file, args, opts) => { spawnCalls.push({ file, args, opts }); return makeFakePty(); } },
};

const { SessionManager } = require('../server/manager');

function newManager() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-test-'));
  // backend:'pty' 让测试断言直接 spawn 的参数,不经 tmux 包装
  const m = new SessionManager({ dataDir, baseUrl: 'http://127.0.0.1:0', onChange: () => { }, onNotify: () => { }, backend: 'pty' });
  clearInterval(m._staleTimer);
  return m;
}

test('首次启动:无 session_id 时按原样传初始命令,不带 --resume', () => {
  const m = newManager();
  spawnCalls.length = 0;
  const s = m.createSession({ type: 'claude', projectDir: os.tmpdir(), command: '修复登录 bug', isolate: false });
  const call = spawnCalls.at(-1);
  assert.equal(call.file, 'claude');
  assert.ok(!call.args.includes('--resume'), '首次启动不应带 --resume');
  assert.ok(call.args.includes('修复登录 bug'), '首次启动应传初始命令');
  clearTimeout(m._saveT);
  void s;
});

test('applyHook 从 payload 捕获 Claude 的 session_id', () => {
  const m = newManager();
  const s = m.createSession({ type: 'claude', projectDir: os.tmpdir(), isolate: false });
  m.applyHook(s.id, 'UserPromptSubmit', { session_id: 'abc-123', hook_event_name: 'UserPromptSubmit' });
  assert.equal(s.claudeSessionId, 'abc-123');
  // 后续 hook 更新为最新值(resume 会产生新 id)
  m.applyHook(s.id, 'Stop', { session_id: 'def-456' });
  assert.equal(s.claudeSessionId, 'def-456');
  clearTimeout(m._saveT);
});

test('已有 session_id 时重启:带 --resume <id>,且不再重发初始命令', () => {
  const m = newManager();
  const s = m.createSession({ type: 'claude', projectDir: os.tmpdir(), command: '修复登录 bug', isolate: false });
  m.applyHook(s.id, 'UserPromptSubmit', { session_id: 'abc-123' });
  spawnCalls.length = 0;
  m._spawn(s); // restart() 内部经 300ms 定时器调用 _spawn,这里直接触发
  const call = spawnCalls.at(-1);
  const i = call.args.indexOf('--resume');
  assert.ok(i >= 0, '重启应带 --resume');
  assert.equal(call.args[i + 1], 'abc-123');
  assert.ok(!call.args.includes('修复登录 bug'), 'resume 时不应重发初始命令');
  clearTimeout(m._saveT);
});

test('terminal 类型不受影响:hook 不写入 claudeSessionId', () => {
  const m = newManager();
  const s = m.createSession({ type: 'terminal', projectDir: os.tmpdir() });
  m.applyHook(s.id, 'Stop', { session_id: 'abc-123' });
  assert.ok(!s.claudeSessionId, 'terminal 会话不应记录 claudeSessionId');
  clearTimeout(m._saveT);
});

test('自动命名优先 Agent 上报 objective,OSC 标题不再覆盖', () => {
  const m = newManager();
  const s = m.createSession({ type: 'claude', projectDir: os.tmpdir(), isolate: false });
  m.applyReport(s.id, { objective: '修复支付回调重复扣款', phase: 'executing', next_action: '继续' });
  assert.equal(s.name, '修复支付回调重复扣款');
  assert.equal(s.nameSource, 'objective');
  m._onTitle(s, '根据PRD制作MVP原型'); // 对话主题类标题
  assert.equal(s.termTitle, '根据PRD制作MVP原型', '标题仍被记录');
  assert.equal(s.name, '修复支付回调重复扣款', '名字不被标题覆盖');
  // 手动命名永远最高
  m.rename(s.id, '我的名字');
  m.applyReport(s.id, { objective: '另一个目标', phase: 'executing', next_action: 'x' });
  assert.equal(s.name, '我的名字');
  clearTimeout(m._saveT);
});

test('extraArgs 拒绝覆盖平台自有/专用标志', () => {
  const m = newManager();
  for (const bad of ['--settings x', '--mcp-config x', '--append-system-prompt x', '--permission-mode plan', '--dangerously-skip-permissions', '--model opus']) {
    assert.throws(
      () => m.createSession({ type: 'claude', projectDir: os.tmpdir(), isolate: false, extraArgs: bad }),
      /不允许包含/,
      `应拒绝 ${bad}`
    );
  }
  clearTimeout(m._saveT);
});

test('未知权限模式被拒绝,合法值放行', () => {
  const m = newManager();
  assert.throws(() => m.createSession({ type: 'claude', projectDir: os.tmpdir(), isolate: false, permissionMode: 'evil' }), /未知权限模式/);
  const s = m.createSession({ type: 'claude', projectDir: os.tmpdir(), isolate: false, permissionMode: 'plan', extraArgs: '--verbose --add-dir ../x' });
  assert.equal(s.permissionMode, 'plan');
  clearTimeout(m._saveT);
});

// ---------- 终端控制权:接管 / 退出接管 ----------

function fakeWs() {
  const ws = {
    readyState: 1, sent: [], handlers: {},
    send(x) { this.sent.push(JSON.parse(x)); },
    on(ev, fn) { this.handlers[ev] = fn; },
  };
  ws.emit = (ev, ...args) => ws.handlers[ev] && ws.handlers[ev](...args);
  ws.lastRole = () => [...ws.sent].reverse().find((m) => m.type === 'role');
  return ws;
}

test('take-control / release-control:接管、退出、空缺时新连接自动成为控制者', () => {
  const m = newManager();
  const s = m.createSession({ type: 'terminal', projectDir: os.tmpdir(), isolate: false });
  const rt = m.runtime.get(s.id);

  const c1 = fakeWs(), c2 = fakeWs();
  m.attach(s.id, c1);
  assert.equal(rt.controller, c1, '第一个连接自动成为控制者');
  assert.equal(c1.lastRole().controller, true);

  m.attach(s.id, c2);
  assert.equal(rt.controller, c1, '第二个连接默认只读');
  assert.equal(c2.lastRole().controller, false);

  // c2 接管:双方都收到新角色
  c2.emit('message', JSON.stringify({ type: 'take-control' }));
  assert.equal(rt.controller, c2);
  assert.equal(c1.lastRole().controller, false);
  assert.equal(c2.lastRole().controller, true);

  // 非控制者发 release-control:不生效
  c1.emit('message', JSON.stringify({ type: 'release-control' }));
  assert.equal(rt.controller, c2, '非控制者退出接管不应改变控制权');

  // 控制者主动退出:控制权空出,而不是转交
  c2.emit('message', JSON.stringify({ type: 'release-control' }));
  assert.equal(rt.controller, null, '控制权应空出');
  assert.equal(c2.lastRole().controller, false);
  assert.equal(c1.lastRole().controller, false, '空缺时不静默转交给其他窗口');

  // 空缺时新连接自动成为控制者(配合前端"进入即接管")
  const c3 = fakeWs();
  m.attach(s.id, c3);
  assert.equal(rt.controller, c3);
  assert.equal(c3.lastRole().controller, true);
  clearTimeout(m._saveT);
});
