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
  const m = new SessionManager({ dataDir, baseUrl: 'http://127.0.0.1:0', onChange: () => { }, onNotify: () => { } });
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
