import { attentionCount } from './watcher.js';

const STATE_LABEL = {
  idle: '未连接', connecting: '连接中', up: '已连接',
  'server-down': 'CCTower 未运行', 'auth-failed': '密钥不可用', retrying: '重连中',
};

export function buildTrayModel(servers, tunnelStates, watcherState) {
  const items = servers.filter((s) => s.enabled).map((s) => {
    const state = tunnelStates.get(s.id) || 'idle';
    const attention = attentionCount(watcherState, s.id);
    return {
      id: s.id, state, attention,
      label: `${s.name} · ${STATE_LABEL[state] || state}${attention ? ` · ${attention} 待处理` : ''}`,
      canBootstrap: state === 'server-down',
    };
  });
  const total = items.reduce((sum, i) => sum + i.attention, 0);
  return { items, badge: total ? String(total) : '' };
}
