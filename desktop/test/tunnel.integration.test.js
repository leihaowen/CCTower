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
