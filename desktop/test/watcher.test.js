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

test('多服务器汇总与断连清零', () => {
  const st = createState();
  applyMessage(st, 'a', { type: 'snapshot', sessions: [{ id: 's1', status: 'blocked' }] });
  applyMessage(st, 'b', { type: 'snapshot', sessions: [{ id: 's1', status: 'review_ready' }, { id: 's2', status: 'needs_permission' }] });
  assert.equal(totalAttention(st), 3);
  dropServer(st, 'b');
  assert.equal(totalAttention(st), 1);
});
