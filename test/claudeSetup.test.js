'use strict';
// 会话 hook 配置:生命周期回调 + PermissionRequest http hook + PostToolUse
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeHookSettings } = require('../server/claudeSetup');

function gen(token) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-setup-'));
  return JSON.parse(fs.readFileSync(writeHookSettings(dir, 'http://127.0.0.1:7080', 'sid1', token), 'utf8'));
}

test('PermissionRequest 走 http hook,匹配全部工具,超时 600s,带令牌头', () => {
  const s = gen('tok123');
  const [entry] = s.hooks.PermissionRequest;
  assert.equal(entry.matcher, '*');
  assert.deepEqual(entry.hooks[0], {
    type: 'http',
    url: 'http://127.0.0.1:7080/api/hook/sid1/PermissionRequest',
    timeout: 600,
    headers: { 'X-CCW-Token': 'tok123' },
  });
});

test('无令牌时 http hook 不带 headers', () => {
  const s = gen('');
  assert.ok(!('headers' in s.hooks.PermissionRequest[0].hooks[0]));
});

test('PostToolUse 异步回调,不拖慢工具执行', () => {
  const s = gen('');
  const h = s.hooks.PostToolUse[0].hooks[0];
  assert.equal(h.type, 'command');
  assert.equal(h.async, true);
  assert.match(h.command, /\/api\/hook\/sid1\/PostToolUse/);
});

test('原有生命周期 hook 保留', () => {
  const s = gen('');
  for (const ev of ['Notification', 'Stop', 'SubagentStop', 'SessionEnd', 'UserPromptSubmit']) {
    assert.ok(s.hooks[ev], `缺少 ${ev}`);
  }
});
