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

test('探活在途时子进程退出重连:过期结果被丢弃', async () => {
  const timers = makeTimers();
  const sp = makeSpawner();
  const states = [];
  let deferredResolve;
  let probeCalls = 0;
  const probe = () => {
    probeCalls++;
    if (probeCalls === 1) {
      // 老一代子进程的探活:手动可控,不立即 resolve
      return new Promise((resolve) => { deferredResolve = resolve; });
    }
    return Promise.resolve(true); // 新一代子进程的探活:立刻成功
  };
  const t = new Tunnel({
    server: { id: 'a', name: 'a', sshAlias: 'a', remotePort: 7080, token: '', enabled: true },
    localPort: 17080,
    spawn: sp.spawn,
    probe,
    onState: (s, d) => states.push([s, d]),
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });

  t.start(); // connecting,spawn#1,安排第一次探活
  const pending = timers.fire(); // 触发探活,内部在 await this._probe(...) 处挂起
  assert.equal(sp.calls.length, 1);

  sp.child().emitExit(1); // 老子进程退出 → retrying,安排重连定时器
  assert.equal(t.state, 'retrying');

  await timers.fire(); // 触发重连 → _launch() 生成新一代子进程(spawn#2)
  assert.equal(sp.calls.length, 2);
  assert.equal(t.state, 'connecting');

  deferredResolve(true); // 老探活此刻才 resolve(true)
  await pending; // 等老 _runProbe 走完:世代号不匹配,应提前返回,不改变状态

  assert.equal(t.state, 'connecting'); // 未被过期结果拉去 'up'
  assert.equal(sp.calls.length, 2); // 没有额外重连

  await timers.fire(); // 新一代子进程自己的探活(立刻成功)
  assert.equal(t.state, 'up');
  assert.equal(sp.calls.length, 2);
});

// ---- 端口冲突与退避:实测过的"状态灯匀速闪烁"就是这两条一起失效造成的 ----

function makeConflictTunnel({ probeResults, ports }) {
  const timers = makeTimers();
  const sp = makeSpawner();
  const states = [];
  const conflicts = [];
  let clock = 0;
  const t = new Tunnel({
    server: { id: 'a', name: 'a', sshAlias: 'a', remotePort: 7080, token: '', enabled: true },
    localPort: 17080,
    spawn: sp.spawn,
    probe: async () => probeResults.shift() ?? false,
    onState: (s, d) => states.push([s, d]),
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    now: () => clock,
    onPortConflict: (busy) => { conflicts.push(busy); return ports.shift(); },
  });
  return { t, timers, sp, states, conflicts, tick: (ms) => { clock += ms; } };
}

test('bind 冲突:换端口重试,不再死磕同一个端口', async () => {
  const { t, timers, sp, conflicts } = makeConflictTunnel({ probeResults: [], ports: [17081] });
  t.start();
  sp.child().emitStderr('bind [127.0.0.1]:17080: Address already in use\ncannot listen to port: 17080');
  sp.child().emitExit(255);
  assert.deepEqual(conflicts, [17080], '应把被占端口报给分配器');
  assert.equal(t.localPort, 17081);
  await timers.fire();
  assert.deepEqual(sp.calls[1].slice(0, 3), ['-N', '-L', '17081:127.0.0.1:7080'], '重连必须用新端口');
});

test('bind 冲突:Could not request local forwarding 同样算冲突', async () => {
  const { t, sp, conflicts } = makeConflictTunnel({ probeResults: [], ports: [17081] });
  t.start();
  sp.child().emitStderr('Could not request local forwarding.');
  sp.child().emitExit(255);
  assert.deepEqual(conflicts, [17080]);
});

test('分配器给不出新端口时沿用原端口,不把 localPort 弄成 undefined', async () => {
  const { t, sp } = makeConflictTunnel({ probeResults: [], ports: [undefined] });
  t.start();
  sp.child().emitStderr('bind [127.0.0.1]:17080: Address already in use');
  sp.child().emitExit(255);
  assert.equal(t.localPort, 17080);
});

// 这条是闪烁的直接原因:别人占着端口时探活一直成功,旧实现在探活成功里把 _attempt
// 归零,退避永远停在第一档 → 匀速闪烁。现在退避只看子进程活了多久。
test('探活成功但子进程秒退:退避必须继续增长,不被探活归零', async () => {
  const { t, timers, sp, states } = makeConflictTunnel({
    probeResults: [true, true, true], ports: [],
  });
  t.start();
  await timers.fire();                    // 立即探活成功 → up(实际是别人在应答)
  assert.equal(t.state, 'up');
  sp.child().emitExit(255);               // 自己的 ssh 其实已经死了
  const first = states.filter((s) => s[0] === 'retrying').pop()[1];
  await timers.fire();
  await timers.fire();
  sp.child().emitExit(255);
  const second = states.filter((s) => s[0] === 'retrying').pop()[1];
  const ms = (d) => Number(String(d).match(/^(\d+)/)[1]);
  assert.ok(ms(second) > ms(first), `退避应增长,却是 ${first} → ${second}`);
});

test('子进程活得够久再退出:退避归零,当作一次成功的连接', async () => {
  const { t, timers, sp, states, tick } = makeConflictTunnel({ probeResults: [true], ports: [] });
  t.start();
  await timers.fire();
  sp.child().emitExit(1);
  const firstDelay = states.filter((s) => s[0] === 'retrying').pop()[1];
  await timers.fire();                    // 重连
  tick(60_000);                           // 这一代活了 60 秒
  sp.child().emitExit(1);
  const afterLongRun = states.filter((s) => s[0] === 'retrying').pop()[1];
  const ms = (d) => Number(String(d).match(/^(\d+)/)[1]);
  assert.equal(ms(afterLongRun), ms(firstDelay), '长时间在线后退避应回到第一档');
});
