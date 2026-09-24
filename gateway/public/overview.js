'use strict';
// 一期用 3 秒轮询而不是 WS 推送:总览数据量极小,轮询省掉一整套重连逻辑,
// 手机端切前后台也不会留下僵尸连接。
const STATUS_LABEL = {
  ready: '就绪', executing: '执行中', verifying: '验证中', needs_decision: '需要决策',
  needs_permission: '需要权限', blocked: '阻塞', review_ready: '待审核', completed: '已完成',
  stale: '无进展', terminal_only: '终端', exited: '已退出',
};

function ago(iso) {
  if (!iso) return '从未连接';
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (d < 60) return '刚刚';
  if (d < 3600) return `${d / 60 | 0} 分钟前`;
  if (d < 86400) return `${d / 3600 | 0} 小时前`;
  return `${d / 86400 | 0} 天前`;
}

function card(s) {
  const a = document.createElement('a');
  a.className = `card ${s.online ? 'on' : 'off'}`;
  a.href = `/s/${encodeURIComponent(s.id)}/`;

  const top = document.createElement('div');
  top.className = 'card-top';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = s.name;            // 用 textContent:服务器名是用户输入,拼 HTML 就是 XSS
  top.append(dot, name);
  if (s.attention > 0) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = String(s.attention);
    b.title = '需要你处理的会话数';
    top.append(b);
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = s.online
    ? (s.stale ? '在线 · 状态数据获取中' : '在线')
    : `离线 · 最后在线 ${ago(s.lastSeenAt)}`;

  const counts = document.createElement('div');
  counts.className = 'counts';
  for (const [k, n] of Object.entries(s.counts || {})) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = `${STATUS_LABEL[k] || k} ${n}`;
    counts.append(chip);
  }

  a.append(top, meta, counts);
  return a;
}

async function refresh() {
  let data;
  try {
    const r = await fetch('/api/overview');
    if (r.status === 401) { location.href = '/login'; return; }
    data = await r.json();
  } catch { return; }  // 网络抖动:保留上一屏,下个周期再试

  const list = document.getElementById('list');
  list.textContent = '';
  if (!data.servers.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = '还没有添加服务器。在网关机器上运行:node gateway/cli.js add-server <名字>';
    list.append(e);
    return;
  }
  const total = data.servers.reduce((n, s) => n + s.attention, 0);
  document.title = total ? `(${total}) CCTower 总览` : 'CCTower 总览';
  for (const s of data.servers) list.append(card(s));
}

document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login';
});

refresh();
setInterval(refresh, 3000);
