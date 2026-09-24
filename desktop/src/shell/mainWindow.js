// 主窗口:侧栏渲染 + iframe 懒创建切换。数据从 app.js 的 runtime 读,
// 变化通过 'ccw:changed' CustomEvent 通知(app.js 在 refreshTray 时一并派发)。
// 本文件只做 DOM 渲染与事件接线,业务判断(校验、隧道编排)留在 core/ 与 app.js。
import { saveServers, loadServers } from './store.js';
import { normalizeServer, sshStartArgs } from '../core/servers.js';
import { attentionCount } from '../core/watcher.js';
import { STATE_LABEL } from '../core/trayModel.js';
import { sshRun } from './sshExec.js';
import { initSidebar } from './sidebar.js';

// up/server-down/auth-failed/gave-up 才有专属颜色,其余(idle/connecting/retrying)用 .dot 的默认灰
const DOT = { up: 'dot-up', 'server-down': 'dot-down', 'auth-failed': 'dot-err', 'gave-up': 'dot-err' };
// 这些状态下隧道已经不会自己再连,给出「重试」入口
const RETRYABLE = new Set(['gave-up', 'auth-failed']);
// 删除要点两次:第一次按钮变「确认删除」,超时未点就复原。不用 confirm():
// 各平台 webview 对原生对话框的支持不一致,点了没反应比误删更让人困惑。
const DELETE_CONFIRM_MS = 3000;

export function initMainWindow(runtime, { onServersChanged, onRetry }) {
  const list = document.getElementById('server-list');
  const content = document.getElementById('content');
  const frames = new Map(); // id -> iframe
  let activeId = null;
  let editingId = null;       // 表单当前在编辑哪台;null = 添加模式
  let pendingDelete = null;   // 点过一次「删除」、等待确认的那台
  let pendingTimer = null;

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
    for (const s of runtime.servers) {
      const state = s.enabled ? (runtime.tunnelStates.get(s.id) || 'idle') : 'disabled';
      const n = s.enabled ? attentionCount(runtime.watcher, s.id) : 0;
      const row = document.createElement('div');
      row.className = 'server-row' + (s.id === activeId ? ' active' : '') + (s.enabled ? '' : ' disabled');
      row.innerHTML = `<span class="dot ${DOT[state] || ''}"></span>
        <span class="name"></span>${n ? `<span class="badge">${n}</span>` : ''}`;
      row.querySelector('.name').textContent = s.name;
      row.title = s.enabled ? `${s.name} · ${STATE_LABEL[state] || state}` : `${s.name}(已停用)`; // 折叠态名称是隐掉的,靠悬停辨认是哪台
      // 停用的服务器没有隧道,iframe 无处可连,点了也不切
      if (s.enabled) row.onclick = () => showServer(s.id);

      const actions = document.createElement('div');
      actions.className = 'row-actions';
      if (state === 'server-down') {
        addAction(actions, '启动 CCTower', async () => {
          const { code, stderr } = await sshRun(sshStartArgs(s));
          if (code !== 0) alert(`启动失败:\n${stderr.slice(0, 500)}`);
        });
      }
      if (s.enabled && RETRYABLE.has(state)) addAction(actions, '重试', () => onRetry(s.id));
      addAction(actions, '编辑', () => startEdit(s));
      addAction(actions, s.enabled ? '停用' : '启用', () => mutate((all) =>
        all.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x))));
      const del = addAction(actions, pendingDelete === s.id ? '确认删除' : '删除', () => {
        if (pendingDelete !== s.id) { armDelete(s.id); return; }
        disarmDelete();
        if (editingId === s.id) resetForm();
        return mutate((all) => all.filter((x) => x.id !== s.id));
      });
      del.classList.add('danger');
      row.appendChild(actions);
      list.appendChild(row);
    }
  }

  function addAction(parent, text, fn) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = text;
    btn.onclick = async (e) => {
      e.stopPropagation(); // 别触发行点击的切换
      try { await fn(); } catch (err) { alert(err.message || String(err)); }
    };
    parent.appendChild(btn);
    return btn;
  }

  function armDelete(id) {
    clearTimeout(pendingTimer);
    pendingDelete = id;
    pendingTimer = setTimeout(disarmDelete, DELETE_CONFIRM_MS);
    render();
  }

  function disarmDelete() {
    clearTimeout(pendingTimer);
    pendingDelete = null;
    render();
  }

  // 读-改-写配置,再交给 app.js 按差异重建/停止隧道
  async function mutate(fn) {
    await saveServers(fn(await loadServers()));
    await onServersChanged();
  }

  const form = document.getElementById('add-form');
  const formTitle = form.querySelector('h3');
  const submitBtn = form.querySelector('button[type=submit]');
  const cancelBtn = document.getElementById('form-cancel');

  function startEdit(s) {
    editingId = s.id;
    for (const key of ['sshAlias', 'name', 'remotePort', 'token']) form.elements[key].value = s[key] ?? '';
    formTitle.textContent = `编辑「${s.name}」`;
    submitBtn.textContent = '保存';
    cancelBtn.hidden = false;
    document.getElementById('form-error').textContent = '';
    form.elements.sshAlias.focus();
  }

  function resetForm() {
    editingId = null;
    form.reset();
    formTitle.textContent = '添加服务器';
    submitBtn.textContent = '添加';
    cancelBtn.hidden = true;
    document.getElementById('form-error').textContent = '';
  }

  cancelBtn.onclick = resetForm;

  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      const orig = editingId && runtime.servers.find((s) => s.id === editingId);
      // 编辑沿用原来的启用状态;表单里没有这一项,不带上会被 normalizeServer 默认成启用
      const next = normalizeServer({ ...Object.fromEntries(fd.entries()), enabled: orig ? orig.enabled : true });
      // id 就是 ssh 别名:编辑时改了别名,旧条目也要一并去掉,否则会留下一台"幽灵"服务器
      await mutate((all) => all.filter((s) => s.id !== next.id && s.id !== editingId).concat(next));
      resetForm();
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
