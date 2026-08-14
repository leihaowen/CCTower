// 主窗口:侧栏渲染 + iframe 懒创建切换。数据从 app.js 的 runtime 读,
// 变化通过 'ccw:changed' CustomEvent 通知(app.js 在 refreshTray 时一并派发)。
// 本文件只做 DOM 渲染与事件接线,业务判断(校验、隧道编排)留在 core/ 与 app.js。
import { saveServers, loadServers } from './store.js';
import { normalizeServer, sshStartArgs } from '../core/servers.js';
import { attentionCount } from '../core/watcher.js';
import { sshRun } from './sshExec.js';
import { initSidebar } from './sidebar.js';

// up/server-down/auth-failed 才有专属颜色,其余(idle/connecting/retrying)用 .dot 的默认灰
const DOT = { up: 'dot-up', 'server-down': 'dot-down', 'auth-failed': 'dot-err' };

export function initMainWindow(runtime, { onServersChanged }) {
  const list = document.getElementById('server-list');
  const content = document.getElementById('content');
  const frames = new Map(); // id -> iframe
  let activeId = null;

  // showServer:内容区用 iframe 直连隧道本地端口,懒创建、切换时只切 display。
  // 退路(Mac 上 WKWebView 若拒绝加载 http iframe/混合内容时启用):改为每台服务器一个
  // WebviewWindow(new WebviewWindow(id, { url: `http://127.0.0.1:${port}` })),
  // 其 origin 本身就是 http://127.0.0.1,不存在混合内容问题;届时侧栏窗口只做列表与聚焦,
  // 本函数替换为创建/聚焦对应 WebviewWindow,其余步骤(render/表单/事件)不变。
  function showServer(id) {
    activeId = id;
    if (!frames.has(id)) {
      const f = document.createElement('iframe');
      f.src = `http://127.0.0.1:${runtime.localPorts.get(id)}/`;
      content.appendChild(f);
      frames.set(id, f);
    }
    for (const [fid, f] of frames) f.style.display = fid === id ? 'block' : 'none';
    render();
  }

  function render() {
    // 权限被拒时通知会静默失效,必须在界面上说一声,否则用户以为功能坏了。
    // 放在 render 里是因为权限结果是异步回来的(申请会弹系统对话框),
    // 回来后 app.js 走 refreshTray → ccw:changed → 这里刷新。
    const denied = document.getElementById('notify-denied');
    if (denied) denied.hidden = runtime.notifyGranted !== false;

    list.textContent = '';
    for (const s of runtime.servers.filter((x) => x.enabled)) {
      const state = runtime.tunnelStates.get(s.id) || 'idle';
      const n = attentionCount(runtime.watcher, s.id);
      const row = document.createElement('div');
      row.className = 'server-row' + (s.id === activeId ? ' active' : '');
      row.innerHTML = `<span class="dot ${DOT[state] || ''}"></span>
        <span class="name"></span>${n ? `<span class="badge">${n}</span>` : ''}`;
      row.querySelector('.name').textContent = s.name;
      row.title = s.name; // 折叠态名称是隐掉的,靠悬停辨认是哪台
      row.onclick = () => showServer(s.id);
      if (state === 'server-down') {
        const btn = document.createElement('button');
        btn.textContent = '启动 CCTower';
        btn.onclick = async (e) => {
          e.stopPropagation();
          const { code, stderr } = await sshRun(sshStartArgs(s));
          if (code !== 0) alert(`启动失败:\n${stderr.slice(0, 500)}`);
        };
        row.appendChild(btn);
      }
      list.appendChild(row);
    }
  }

  document.getElementById('add-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const next = normalizeServer(Object.fromEntries(fd.entries()));
      const all = (await loadServers()).filter((s) => s.id !== next.id).concat(next);
      await saveServers(all);
      e.target.reset();
      document.getElementById('form-error').textContent = '';
      await onServersChanged(); // app.js 重建该服务器的隧道
    } catch (err) {
      document.getElementById('form-error').textContent = err.message;
    }
  };

  initSidebar({ toggle: document.getElementById('sidebar-toggle') });

  // 拆掉某台服务器的 iframe。必须有这个入口:frames 是按 id 缓存的,只要条目还在,
  // showServer 就会直接复用旧 iframe——而它的 src 里写死了当时的隧道端口。服务器被
  // 删除/禁用,或改了 ssh 别名、远端端口、隧道换了本地端口之后,那个端口已经失效,
  // 内容区会一直指着死端口,重启应用才能恢复。
  // 返回它是否正是当前显示的那台,调用方据此决定要不要重新挑一台显示。
  function dropServer(id) {
    const frame = frames.get(id);
    if (frame) { frame.remove(); frames.delete(id); }
    const wasActive = activeId === id;
    if (wasActive) activeId = null;
    render();
    return wasActive;
  }

  window.addEventListener('ccw:changed', render);
  render();
  return { showServer, dropServer };
}
