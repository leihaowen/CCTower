'use strict';
// 与服务端的消息契约见规格:snapshot / session / notify,其余类型(tail 等)一律不解析。
const test = require('node:test');
const assert = require('node:assert');
const {
  createState, applyMessage, attentionCount, totalAttention, statusCounts, dropServer,
} = require('../gateway/src/watcher');

test('snapshot 覆盖该服务器的全部会话', () => {
  const st = createState();
  applyMessage(st, 'a', { type: 'snapshot', sessions: [
    { id: '1', status: 'executing' }, { id: '2', status: 'needs_decision' },
  ] });
  assert.deepEqual(statusCounts(st, 'a'), { executing: 1, needs_decision: 1 });
  applyMessage(st, 'a', { type: 'snapshot', sessions: [{ id: '3', status: 'ready' }] });
  assert.deepEqual(statusCounts(st, 'a'), { ready: 1 }, '旧会话必须被整体替换');
});

test('statusCounts 正确累加同一状态的多个会话', () => {
  const st = createState();
  applyMessage(st, 'a', { type: 'snapshot', sessions: [
    { id: '1', status: 'executing' }, { id: '2', status: 'executing' }, { id: '3', status: 'needs_decision' },
    { id: '4', status: 'ready' }, { id: '5', status: 'ready' }, { id: '6', status: 'ready' },
  ] });
  assert.deepEqual(statusCounts(st, 'a'), { executing: 2, needs_decision: 1, ready: 3 }, '必须正确累加每个状态的会话数');
});

test('session 消息增删改单个会话', () => {
  const st = createState();
  applyMessage(st, 'a', { type: 'snapshot', sessions: [{ id: '1', status: 'ready' }] });
  applyMessage(st, 'a', { type: 'session', session: { id: '1', status: 'blocked' } });
  assert.equal(attentionCount(st, 'a'), 1);
  applyMessage(st, 'a', { type: 'session', session: { id: '1', deleted: true } });
  assert.equal(attentionCount(st, 'a'), 0);
});

test('needs_* / blocked / review_ready 计入需注意,其余不计', () => {
  const st = createState();
  applyMessage(st, 'a', { type: 'snapshot', sessions: [
    { id: '1', status: 'needs_decision' }, { id: '2', status: 'needs_permission' },
    { id: '3', status: 'blocked' }, { id: '4', status: 'review_ready' },
    { id: '5', status: 'executing' }, { id: '6', status: 'completed' },
  ] });
  assert.equal(attentionCount(st, 'a'), 4);
});

test('多服务器互不干扰,totalAttention 求和', () => {
  const st = createState();
  applyMessage(st, 'a', { type: 'snapshot', sessions: [{ id: '1', status: 'blocked' }] });
  applyMessage(st, 'b', { type: 'snapshot', sessions: [{ id: '1', status: 'needs_decision' }] });
  assert.equal(totalAttention(st), 2);
  dropServer(st, 'a');
  assert.equal(totalAttention(st), 1);
  assert.deepEqual(statusCounts(st, 'a'), {}, '掉线服务器不再有计数');
});

test('notify 消息带出服务器归属,便于总览高亮', () => {
  const st = createState();
  const r = applyMessage(st, 'aws1', { type: 'notify', id: 's1', name: '会话', reason: 'needs_decision', statusLine: '等你' });
  assert.equal(r.notify.serverId, 'aws1');
  assert.equal(r.notify.sessionId, 's1');
  assert.equal(r.notify.reason, 'needs_decision');
});

test('未知消息类型与畸形消息被安全忽略', () => {
  const st = createState();
  for (const msg of [{ type: 'tail', id: 'x' }, {}, null, { type: 'session' }]) {
    const r = applyMessage(st, 'a', msg);
    assert.deepEqual(r, { notify: null, resolved: [] });
  }
});
