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
