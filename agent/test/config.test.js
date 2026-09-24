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
