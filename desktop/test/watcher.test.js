import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, applyMessage, attentionCount, totalAttention, dropServer } from '../src/core/watcher.js';

test('snapshot 初始化全量状态', () => {
  const st = createState();
  applyMessage(st, 'a', { type: 'snapshot', sessions: [
    { id: 's1', status: 'executing' }, { id: 's2', status: 'needs_decision' }] });
  assert.equal(attentionCount(st, 'a'), 1);
});

test('session 消息:更新、删除', () => {
  const st = createState();
  applyMessage(st, 'a', { type: 'session', session: { id: 's1', status: 'blocked' } });
  assert.equal(attentionCount(st, 'a'), 1);
  applyMessage(st, 'a', { type: 'session', session: { id: 's1', status: 'executing' } });
  assert.equal(attentionCount(st, 'a'), 0);
  applyMessage(st, 'a', { type: 'session', session: { id: 's1', deleted: true } });
  assert.equal(st.get('a').size, 0);
});

test('notify 消息透传为通知副作用,其余类型忽略', () => {
  const st = createState();
  const out = applyMessage(st, 'a', { type: 'notify', id: 's1', name: '会话一', reason: '需要决策', statusLine: '等待选择' });
  assert.deepEqual(out.notify, { serverId: 'a', sessionId: 's1', name: '会话一', reason: '需要决策', statusLine: '等待选择' });
  assert.equal(applyMessage(st, 'a', { type: 'tail', id: 's1' }).notify, null);
  assert.equal(applyMessage(st, 'a', { type: '未知' }).notify, null);
});

test('resolved:会话离开注意力状态时报出来,好撤掉已发的通知', () => {
  const st = createState();
  applyMessage(st, 'a', { type: 'session', session: { id: 's1', status: 'needs_decision' } });
  const out = applyMessage(st, 'a', { type: 'session', session: { id: 's1', status: 'executing' } });
  assert.deepEqual(out.resolved, ['s1']);
});

test('resolved:注意力态之间互转不算已处理(仍需要人)', () => {
  const st = createState();
  applyMessage(st, 'a', { type: 'session', session: { id: 's1', status: 'needs_decision' } });
  const out = applyMessage(st, 'a', { type: 'session', session: { id: 's1', status: 'blocked' } });
  assert.deepEqual(out.resolved, [], 'needs_decision → blocked 还是要人管,不该撤通知');
});

test('resolved:删除会话要撤通知;普通态转普通态没有可撤的', () => {
  const st = createState();
  applyMessage(st, 'a', { type: 'session', session: { id: 's1', status: 'blocked' } });
  assert.deepEqual(applyMessage(st, 'a', { type: 'session', session: { id: 's1', deleted: true } }).resolved, ['s1']);
  applyMessage(st, 'a', { type: 'session', session: { id: 's2', status: 'executing' } });
  assert.deepEqual(applyMessage(st, 'a', { type: 'session', session: { id: 's2', status: 'idle' } }).resolved, []);
});

test('resolved:snapshot 要对比出已被处理掉与已消失的会话', () => {
  const st = createState();
  applyMessage(st, 'a', { type: 'snapshot', sessions: [
    { id: 's1', status: 'needs_decision' }, { id: 's2', status: 'blocked' },
    { id: 's3', status: 'review_ready' }, { id: 's4', status: 'executing' }] });
  const out = applyMessage(st, 'a', { type: 'snapshot', sessions: [
    { id: 's1', status: 'executing' },      // 已处理 → 撤
    { id: 's2', status: 'needs_permission' }, // 仍需人 → 不撤
    { id: 's4', status: 'executing' }] });   // s3 整个消失 → 撤
  assert.deepEqual(out.resolved.sort(), ['s1', 's3']);
  assert.equal(attentionCount(st, 'a'), 1);
});

test('多服务器汇总与断连清零', () => {
  const st = createState();
  applyMessage(st, 'a', { type: 'snapshot', sessions: [{ id: 's1', status: 'blocked' }] });
  applyMessage(st, 'b', { type: 'snapshot', sessions: [{ id: 's1', status: 'review_ready' }, { id: 's2', status: 'needs_permission' }] });
  assert.equal(totalAttention(st), 3);
  dropServer(st, 'b');
  assert.equal(totalAttention(st), 1);
});
