import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrayModel } from '../src/core/trayModel.js';
import { createState, applyMessage } from '../src/core/watcher.js';

const servers = [
  { id: 'a', name: '生产', sshAlias: 'a', remotePort: 7080, token: '', enabled: true },
  { id: 'b', name: '测试', sshAlias: 'b', remotePort: 7080, token: '', enabled: false },
];

test('禁用的服务器不出现;标签含连接状态与待处理数', () => {
  const ws = createState();
  applyMessage(ws, 'a', { type: 'snapshot', sessions: [{ id: 's1', status: 'blocked' }, { id: 's2', status: 'executing' }] });
  const m = buildTrayModel(servers, new Map([['a', 'up']]), ws);
  assert.equal(m.items.length, 1);
  assert.deepEqual(m.items[0], { id: 'a', state: 'up', attention: 1, label: '生产 · 已连接 · 1 待处理', canBootstrap: false });
  assert.equal(m.badge, '1');
});

test('server-down 时可一键启动;无待处理时角标为空串', () => {
  const m = buildTrayModel(servers, new Map([['a', 'server-down']]), createState());
  assert.equal(m.items[0].canBootstrap, true);
  assert.equal(m.items[0].label, '生产 · CCTower 未运行');
  assert.equal(m.badge, '');
});
