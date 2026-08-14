import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reasonLabel, tunnelLabel, notificationId, sessionNotificationId,
  sessionNotification, tunnelNotification,
} from '../src/core/notifyModel.js';

test('reason 裸键映射成中文,未知键原样透出而不是变 undefined', () => {
  assert.equal(reasonLabel('needs_decision'), '需要决策');
  assert.equal(reasonLabel('needs_permission'), '需要权限');
  assert.equal(reasonLabel('blocked'), '阻塞');
  assert.equal(reasonLabel('review_ready'), '完成待审');
  assert.equal(reasonLabel('某个新状态'), '某个新状态');
  assert.equal(reasonLabel(undefined), '需要你');
});

test('隧道状态映射成中文', () => {
  assert.equal(tunnelLabel('auth-failed'), '密钥不可用');
  assert.equal(tunnelLabel('server-down'), 'CCTower 未运行');
  assert.equal(tunnelLabel('flapping'), '隧道反复重连');
  assert.equal(tunnelLabel(undefined), '异常');
});

test('通知 id 是稳定的 32 位非负整数', () => {
  const a = sessionNotificationId('srv', 'sess');
  assert.equal(a, sessionNotificationId('srv', 'sess'), '同输入必须同输出,否则撤销时对不上');
  assert.ok(Number.isInteger(a) && a > 0 && a <= 0x7fffffff, `越界:${a}`);
});

test('不同来源不撞 id;服务器与会话维度都要区分', () => {
  const ids = new Set([
    sessionNotificationId('a', 's1'), sessionNotificationId('a', 's2'),
    sessionNotificationId('b', 's1'), notificationId('tunnel', 'a'), notificationId('tunnel', 'b'),
  ]);
  assert.equal(ids.size, 5);
});

test('会话通知:中文标题 + extra 带 serverId 供点击跳转', () => {
  const n = sessionNotification({
    serverId: 'srv', sessionId: 's1', name: '修登录 bug', reason: 'needs_permission', statusLine: '要不要允许写文件',
  });
  assert.equal(n.title, '修登录 bug · 需要权限');
  assert.equal(n.body, '要不要允许写文件');
  assert.deepEqual(n.extra, { serverId: 'srv', sessionId: 's1' });
  assert.equal(n.group, 'ccw:srv');
  assert.equal(n.id, sessionNotificationId('srv', 's1'), 'id 必须与撤销时算出的一致');
});

test('会话通知:缺字段不产出 undefined 文案', () => {
  const n = sessionNotification({ serverId: 'srv', sessionId: 's1' });
  assert.equal(n.title, '会话 · 需要你');
  assert.equal(n.body, '');
});

test('隧道通知:同一服务器共用 id(后一条顶掉前一条,不堆积)', () => {
  const a = tunnelNotification({ serverId: 'srv', serverName: 'NimoOS', state: 'server-down', detail: 'x' });
  const b = tunnelNotification({ serverId: 'srv', serverName: 'NimoOS', state: 'auth-failed', detail: 'y' });
  assert.equal(a.id, b.id);
  assert.equal(a.title, 'NimoOS · CCTower 未运行');
  assert.equal(b.title, 'NimoOS · 密钥不可用');
});

test('隧道通知:超长 stderr 截断,不塞爆通知', () => {
  const n = tunnelNotification({ serverId: 'srv', serverName: 'S', state: 'auth-failed', detail: 'x'.repeat(5000) });
  assert.equal(n.body.length, 200);
});
