import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAlertState, noteState, dueAlerts, forgetServer,
  SUSTAINED_MS, FLAP_THRESHOLD, FLAP_WINDOW_MS,
} from '../src/core/failureAlert.js';

test('auth-failed 是终态:立即告警,且只告警一次', () => {
  const st = createAlertState();
  const a = noteState(st, 'srv', 'auth-failed', 'Permission denied (publickey)', 1000);
  assert.deepEqual(a, { state: 'auth-failed', detail: 'Permission denied (publickey)' });
  assert.equal(noteState(st, 'srv', 'auth-failed', '', 2000), null, '重复状态不该再推');
  assert.deepEqual(dueAlerts(st, 1000 + SUSTAINED_MS * 2), [], '已推过就不该再被持续检查捞出来');
});

test('短暂抖动不打扰:60s 内恢复,一条都不推', () => {
  const st = createAlertState();
  assert.equal(noteState(st, 'srv', 'connecting', '', 0), null);
  assert.deepEqual(dueAlerts(st, 30_000), [], '还没到阈值');
  assert.equal(noteState(st, 'srv', 'up', '', 40_000), null, '恢复不推通知');
  assert.deepEqual(dueAlerts(st, 10 * SUSTAINED_MS), [], '恢复后不该再补推');
});

test('持续故障:非 up 超过阈值推一次,之后不再重复', () => {
  const st = createAlertState();
  noteState(st, 'srv', 'server-down', 'CCTower 没起来', 0);
  assert.deepEqual(dueAlerts(st, SUSTAINED_MS - 1), []);
  assert.deepEqual(dueAlerts(st, SUSTAINED_MS), [{ serverId: 'srv', state: 'server-down', detail: 'CCTower 没起来' }]);
  assert.deepEqual(dueAlerts(st, SUSTAINED_MS * 5), [], '同一轮故障只推一次');
});

test('恢复后再次故障,能重新告警(去重状态按轮次重置)', () => {
  const st = createAlertState();
  noteState(st, 'srv', 'server-down', '', 0);
  assert.equal(dueAlerts(st, SUSTAINED_MS).length, 1);
  noteState(st, 'srv', 'up', '', SUSTAINED_MS + 1);
  noteState(st, 'srv', 'server-down', '', SUSTAINED_MS + 2);
  assert.equal(dueAlerts(st, SUSTAINED_MS * 2 + 2).length, 1, '新一轮故障应重新告警');
});

// 这条盖的是"持续检查"的盲区:每次短暂 up 都会重置持续计时,
// 单靠时长永远告不出来,而反复重连恰恰最需要人介入(实测过的真实故障形态)。
test('反复 up/故障 抖动:达到次数阈值时告警一次', () => {
  const st = createAlertState();
  let out = null;
  for (let i = 0; i < FLAP_THRESHOLD; i++) {
    out = noteState(st, 'srv', 'retrying', 'bind: Address already in use', i * 1000) || out;
    noteState(st, 'srv', 'up', '', i * 1000 + 500);
  }
  assert.equal(out.state, 'flapping');
  assert.match(out.detail, /Address already in use/);
});

test('抖动次数按时间窗口滑动:跨窗口的老记录不累计', () => {
  const st = createAlertState();
  for (let i = 0; i < FLAP_THRESHOLD - 1; i++) {
    noteState(st, 'srv', 'retrying', '', i * 1000);
    noteState(st, 'srv', 'up', '', i * 1000 + 500);
  }
  // 隔了远超窗口的时间再抖一次,不该被判为反复重连
  const late = noteState(st, 'srv', 'retrying', '', FLAP_WINDOW_MS * 3);
  assert.equal(late, null);
});

test('抖动告警也只推一次', () => {
  const st = createAlertState();
  const hits = [];
  for (let i = 0; i < FLAP_THRESHOLD * 3; i++) {
    const a = noteState(st, 'srv', 'retrying', '', i * 1000);
    if (a) hits.push(a);
    noteState(st, 'srv', 'up', '', i * 1000 + 500);
  }
  assert.equal(hits.filter((h) => h.state === 'flapping').length, 1);
});

test('多服务器互不干扰', () => {
  const st = createAlertState();
  noteState(st, 'a', 'server-down', '', 0);
  noteState(st, 'b', 'connecting', '', 0);
  noteState(st, 'b', 'up', '', 1000);
  assert.deepEqual(dueAlerts(st, SUSTAINED_MS).map((x) => x.serverId), ['a']);
});

test('forgetServer 清掉状态:删掉又加回来的服务器不带旧的去重标记', () => {
  const st = createAlertState();
  noteState(st, 'srv', 'auth-failed', '', 0);
  forgetServer(st, 'srv');
  assert.deepEqual(noteState(st, 'srv', 'auth-failed', 'again', 1), { state: 'auth-failed', detail: 'again' });
});
