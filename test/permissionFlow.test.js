'use strict';
// manager 接入 PermissionRequest:状态切换、网页作答、终端已处理时撤卡、旧按钮兼容
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const writes = [];
const ptyPath = require.resolve('node-pty');
require.cache[ptyPath] = {
  id: ptyPath, filename: ptyPath, loaded: true,
  exports: { spawn: () => ({ onData() { }, onExit() { }, write: (d) => writes.push(d), resize() { }, kill() { } }) },
};
const { SessionManager } = require('../server/manager');

function fakeRes() {
  const res = new EventEmitter();
  res.json = (b) => { res.body = b; res.writableEnded = true; res.emit('close'); return res; };
  res.end = () => { res.body = null; res.writableEnded = true; res.emit('close'); return res; };
  return res;
}

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-perm-'));
  const notified = [];
  const m = new SessionManager({ dataDir, baseUrl: 'http://127.0.0.1:0', onChange: () => { }, onNotify: (s, r) => notified.push(r), backend: 'pty' });
  clearInterval(m._staleTimer);
  const s = m.createSession({ type: 'claude', projectDir: os.tmpdir(), isolate: false });
  s.status = 'executing';
  return { m, s, notified, done: () => { clearTimeout(m._saveT); m.permissions.dispose(); } };
}

const bash = { session_id: 'c1', tool_name: 'Bash', tool_input: { command: 'npm publish' }, permission_suggestions: [] };
const ask = { session_id: 'c1', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '发布到哪?', header: '目标', options: [{ label: 'npm' }, { label: 'GitHub' }], multiSelect: false }] } };

test('权限请求:立即进入 needs_permission,状态行带命令,并推送通知', () => {
  const { m, s, notified, done } = setup();
  m.openPermissionRequest(s.id, bash, fakeRes());
  assert.equal(s.status, 'needs_permission');
  assert.match(s.statusLine, /Bash.*npm publish/);
  assert.deepEqual(notified, ['needs_permission']);
  assert.equal(m.pendingRequests(s.id).length, 1);
  assert.equal(s.claudeSessionId, 'c1');
  done();
});

test('AskUserQuestion:进入 needs_decision', () => {
  const { m, s, done } = setup();
  m.openPermissionRequest(s.id, ask, fakeRes());
  assert.equal(s.status, 'needs_decision');
  assert.match(s.statusLine, /发布到哪/);
  done();
});

test('网页作答:回写决定、记入决策时间线、状态回到执行中', () => {
  const { m, s, done } = setup();
  const res = fakeRes();
  const r = m.openPermissionRequest(s.id, ask, res);
  m.resolveRequest(s.id, { requestId: r.id, behavior: 'allow', answers: { '发布到哪?': 'GitHub' } });
  assert.equal(res.body.hookSpecificOutput.decision.updatedInput.answers['发布到哪?'], 'GitHub');
  assert.equal(s.status, 'executing');
  const last = s.decisions.at(-1);
  assert.equal(last.kind, 'question');
  assert.match(last.answer, /GitHub/);
  assert.deepEqual(m.pendingRequests(s.id), []);
  done();
});

test('不能用别的会话 id 处理请求', () => {
  const { m, s, done } = setup();
  const r = m.openPermissionRequest(s.id, bash, fakeRes());
  const other = m.createSession({ type: 'claude', projectDir: os.tmpdir(), isolate: false });
  assert.throws(() => m.resolveRequest(other.id, { requestId: r.id, behavior: 'allow' }), /不存在/);
  done();
});

test('多个挂起:处理一个后,状态切到下一个', () => {
  const { m, s, done } = setup();
  const r1 = m.openPermissionRequest(s.id, bash, fakeRes());
  m.openPermissionRequest(s.id, ask, fakeRes());
  m.resolveRequest(s.id, { requestId: r1.id, behavior: 'deny', message: '先别发' });
  assert.equal(s.status, 'needs_decision');
  assert.match(s.statusLine, /发布到哪/);
  done();
});

test('终端先批准:PostToolUse 撤掉卡片、回空响应、记"在终端中处理"', () => {
  const { m, s, done } = setup();
  const res = fakeRes();
  m.openPermissionRequest(s.id, bash, res);
  m.applyHook(s.id, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm publish' }, tool_response: {} });
  assert.equal(res.body, null);
  assert.deepEqual(m.pendingRequests(s.id), []);
  assert.equal(s.status, 'executing');
  assert.match(s.decisions.at(-1).answer, /终端/);
  done();
});

test('无关工具的 PostToolUse 不影响挂起请求,也不刷事件时间线', () => {
  const { m, s, done } = setup();
  m.openPermissionRequest(s.id, bash, fakeRes());
  const n = s.events.length;
  m.applyHook(s.id, 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/x' } });
  assert.equal(m.pendingRequests(s.id).length, 1);
  assert.equal(s.status, 'needs_permission');
  assert.equal(s.events.length, n);
  done();
});

test('回合结束(Stop):释放全部挂起请求', () => {
  const { m, s, done } = setup();
  const res = fakeRes();
  m.openPermissionRequest(s.id, bash, res);
  m.applyHook(s.id, 'Stop', {});
  assert.equal(res.body, null);
  assert.deepEqual(m.pendingRequests(s.id), []);
  assert.equal(s.status, 'review_ready');
  done();
});

test('随后到来的权限 Notification 不覆盖更具体的状态行', () => {
  const { m, s, done } = setup();
  m.openPermissionRequest(s.id, bash, fakeRes());
  const line = s.statusLine;
  m.applyHook(s.id, 'Notification', { message: 'Claude needs your permission to use Bash' });
  assert.equal(s.statusLine, line);
  done();
});

test('旧的批准按钮:有挂起请求时走 hook 回写,不再发按键', () => {
  const { m, s, done } = setup();
  const res = fakeRes();
  m.openPermissionRequest(s.id, bash, res);
  writes.length = 0;
  assert.ok(m.permissionAction(s.id, true));
  assert.equal(res.body.hookSpecificOutput.decision.behavior, 'allow');
  assert.deepEqual(writes, []);
  done();
});

test('旧的批准按钮:没有挂起请求时仍发按键兜底', () => {
  const { m, s, done } = setup();
  writes.length = 0;
  s.status = 'needs_permission';
  assert.ok(m.permissionAction(s.id, false));
  assert.deepEqual(writes, ['\x1b']);
  done();
});

test('未知会话的权限请求:回空响应,交还终端', () => {
  const { m, done } = setup();
  const res = fakeRes();
  assert.equal(m.openPermissionRequest('nope', bash, res), null);
  assert.equal(res.body, null);
  done();
});
