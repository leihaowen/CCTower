/* Agent Workbench — 前端(无构建,原生 JS) */
'use strict';

const STATUS = {
  ready:            { label: '就绪',     color: 'var(--c-ready)' },
  executing:        { label: '执行中',   color: 'var(--c-executing)',        pulse: true },
  verifying:        { label: '验证中',   color: 'var(--c-verifying)',        pulse: true },
  needs_decision:   { label: '需要决策', color: 'var(--c-needs_decision)',   breathe: true },
  needs_permission: { label: '需要权限', color: 'var(--c-needs_permission)', breathe: true },
  blocked:          { label: '阻塞',     color: 'var(--c-blocked)' },
  review_ready:     { label: '待审核',   color: 'var(--c-review_ready)' },
  completed:        { label: '已完成',   color: 'var(--c-completed)' },
  stale:            { label: '无进展',   color: 'var(--c-stale)' },
  terminal_only:    { label: '终端',     color: 'var(--c-terminal_only)' },
  exited:           { label: '已退出',   color: 'var(--c-exited)' },
};
const INBOX_GROUPS = [
  ['needs_permission', 'Needs permission · 需要批准'],
  ['needs_decision',   'Needs decision · 需要你决定'],
  ['blocked',          'Blocked · 阻塞'],
  ['review_ready',     'Review ready · 完成待审'],
];
const SRC_LABEL = { agent_reported: 'Agent 上报', observed: '系统观测', ai_inferred: 'AI 归纳' };

const state = {
  sessions: new Map(),
  view: 'inbox',
  currentId: null,
  filter: 'active', // active | attention | archived | all
  typeFilter: 'all',
};

const $ = (sel, el = document) => el.querySelector(sel);
const main = $('#main');

/* ---------- utils ---------- */
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function ago(iso) {
  if (!iso) return '—';
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (d < 10) return '刚刚';
  if (d < 60) return `${d | 0} 秒前`;
  if (d < 3600) return `${(d / 60) | 0} 分钟前`;
  if (d < 86400) return `${(d / 3600) | 0} 小时前`;
  return `${(d / 86400) | 0} 天前`;
}
function dirTail(p) { const parts = (p || '').split('/').filter(Boolean); return parts.slice(-2).join('/'); }
const authToken = () => localStorage.getItem('ccwToken') || '';
const authHeaders = () => (authToken() ? { 'X-CCW-Token': authToken() } : {});
// WS 协议跟随页面:HTTPS 反代下必须用 wss,否则浏览器按混合内容拦截
const WS_BASE = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
// WS 令牌走 Sec-WebSocket-Protocol 子协议(base64url),不进 URL,避免泄漏到日志/历史
const wsProto = () => {
  const t = authToken();
  if (!t) return undefined;
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(t)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return ['ccw.token.' + b64];
};
async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { promptToken(); throw new Error('unauthorized'); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}
function promptToken() {
  const t = prompt('此 CCTower 已开启访问令牌(CCW_TOKEN),请输入:');
  if (t !== null) { localStorage.setItem('ccwToken', t.trim()); location.reload(); }
}
const act = (id, op, value) => api(`/api/sessions/${id}/action`, { op, value });

async function readClipboard() {
  try { return await navigator.clipboard.readText(); }
  catch { toast('无法读取剪贴板', '浏览器未授权;请直接用 Ctrl+V 粘贴'); return ''; }
}

/* ---------- websocket: state stream ---------- */
let eventsWs = null;
function connectEvents() {
  if (eventsWs && (eventsWs.readyState === 0 || eventsWs.readyState === 1)) return;
  const ws = new WebSocket(`${WS_BASE}/ws/events`, wsProto());
  eventsWs = ws;
  ws.onopen = () => $('#connbar').hidden = true;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'snapshot') {
      state.sessions.clear();
      for (const s of m.sessions) state.sessions.set(s.id, s);
      render();
    } else if (m.type === 'session') {
      if (m.session.deleted) state.sessions.delete(m.session.id);
      else state.sessions.set(m.session.id, m.session);
      render();
    } else if (m.type === 'tail') {
      const s = state.sessions.get(m.id);
      if (s) { s.tailCache = m.tail; s.tailHtml = m.html; }
      document.querySelectorAll(`.mini-term[data-id="${m.id}"]`).forEach((el) => {
        // html 由服务端逐段转义生成,只含着色 span
        if (m.html !== undefined) el.innerHTML = m.html;
        else el.textContent = m.tail;
        el.scrollTop = el.scrollHeight;
      });
    } else if (m.type === 'notify') {
      notify(m);
    }
  };
  ws.onclose = () => {
    $('#connbar').hidden = false;
    setTimeout(connectEvents, 1500);
  };
}
// 标签页长时间挂起后恢复时,立即重建连接,避免页面"假死"
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) connectEvents();
});

/* ---------- notifications ---------- */
function notify(m) {
  const s = STATUS[m.reason] || {};
  toast(`${m.name} · ${s.label || m.reason}`, m.statusLine, () => openSession(m.id));
  if (Notification.permission === 'granted' && document.hidden) {
    const n = new Notification(`${m.name} — ${s.label || m.reason}`, { body: m.statusLine, tag: `ccw-${m.id}` });
    n.onclick = () => { window.focus(); openSession(m.id); };
  }
}
function toast(title, body, onClick, ttl = 8000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<b>${esc(title)}</b><span>${esc(body || '')}</span>`;
  el.onclick = () => { el.remove(); onClick && onClick(); };
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ttl);
}

/* ---------- brief html ---------- */
function briefHTML(s) {
  const b = s.brief;
  const st = STATUS[s.status] || {};
  if (!b) {
    return `<div class="brief"><h3>${esc(s.name)}<span class="status-pill" style="--pc:${st.color}">${st.label || s.status}</span></h3>
      <dl><dt>状态</dt><dd>${esc(s.statusLine)}</dd>
      ${s.type === 'terminal' ? `<dt>说明</dt><dd>普通终端,平台不推断业务进度${s.note ? '' : ';可在详情页写手工备注'}</dd>` : '<dt>摘要</dt><dd>尚无 Agent 上报;可在详情页刷新摘要</dd>'}
      ${s.note ? `<dt>备注</dt><dd>${esc(s.note)}</dd>` : ''}</dl>
      <div class="meta"><span>来源:系统观测</span><span>最近活动 ${ago(s.lastActivityAt)}</span></div></div>`;
  }
  const prog = b.progress && b.progress.total
    ? `<dd>${b.progress.done}/${b.progress.total}${b.completed?.length ? ',已完成 ' + esc(b.completed.slice(-2).join('、')) : ''}
       <div class="progress-bar"><i style="width:${Math.min(100, b.progress.done / b.progress.total * 100)}%"></i></div></dd>`
    : `<dd>${esc((b.completed || []).slice(-2).join('、') || '—')}</dd>`;
  return `<div class="brief">
    <h3>${esc(s.name)}<span class="status-pill" style="--pc:${st.color}">${st.label || s.status}</span></h3>
    <dl>
      <dt>目标</dt><dd>${esc(b.objective || '—')}</dd>
      <dt>进度</dt>${prog}
      ${b.decision ? `<dt>需要你决定</dt><dd class="warn">${esc(b.decision.question)}</dd>
        ${b.decision.recommended ? `<dt>推荐</dt><dd>${esc(b.decision.recommended)}${b.decision.reason ? ';' + esc(b.decision.reason) : ''}</dd>` : ''}` : ''}
      ${b.blocker ? `<dt>阻塞</dt><dd class="block">${esc(b.blocker)}</dd>` : ''}
      <dt>下一步</dt><dd>${esc(b.next_action || '—')}</dd>
      ${b.evidence?.length ? `<dt>证据</dt><dd>${esc(b.evidence.slice(-3).join(' · '))}</dd>` : ''}
    </dl>
    <div class="meta"><span>来源:${SRC_LABEL[b.source] || b.source}${s.briefFlagged ? ' · 已被标记不准确' : ''}</span><span>${b.source === 'agent_reported' ? '上报于' : '生成于'} ${ago(b.updated_at)}</span></div>
  </div>`;
}

/* ---------- hover popover ---------- */
const popover = $('#popover');
let hoverTimer = null;
function bindHover(cardEl, sessionId) {
  const show = () => {
    const s = state.sessions.get(sessionId);
    if (!s) return;
    popover.innerHTML = briefHTML(s);
    popover.hidden = false;
    const r = cardEl.getBoundingClientRect();
    const pw = 430, ph = popover.offsetHeight || 220;
    let x = Math.min(r.right - pw, window.innerWidth - pw - 12);
    let y = r.bottom + 8;
    if (y + ph > window.innerHeight - 12) y = Math.max(12, r.top - ph - 8);
    popover.style.left = `${Math.max(12, x)}px`;
    popover.style.top = `${y}px`;
  };
  const enter = () => { clearTimeout(hoverTimer); hoverTimer = setTimeout(show, 380); };
  const leave = () => { clearTimeout(hoverTimer); popover.hidden = true; };
  cardEl.addEventListener('mouseenter', enter);
  cardEl.addEventListener('mouseleave', leave);
  cardEl.addEventListener('focus', enter);
  cardEl.addEventListener('blur', leave);
}

/* ---------- render ---------- */
function render() {
  $('#inbox-count').textContent = inboxSessions().length;
  $('#inbox-count').classList.toggle('hot', inboxSessions().length > 0);
  $('#sessions-count').textContent = [...state.sessions.values()].filter((s) => !s.archived).length;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  popover.hidden = true;
  if (state.view === 'inbox') renderInbox();
  else if (state.view === 'sessions') renderSessions();
  else if (state.view === 'workspace') renderWorkspace();
}

function inboxSessions() {
  return [...state.sessions.values()].filter((s) => !s.archived && INBOX_GROUPS.some(([k]) => k === s.status));
}

// 状态灯:绿色跑马灯=运行中,黄色闪烁=需要你,蓝色=就绪,红色=出意外,绿色常亮=完成待审
function lampClass(s) {
  if (s.status === 'blocked' || (!s.alive && s.type === 'claude' && s.exitCode > 0)) return 'lamp-err';
  if (s.status === 'needs_decision' || s.status === 'needs_permission') return 'lamp-warn';
  if ((s.status === 'executing' || s.status === 'verifying') && s.alive) return 'lamp-run';
  if (s.status === 'ready' || (s.status === 'terminal_only' && s.alive)) return 'lamp-ready';
  if (s.status === 'review_ready' || s.status === 'completed') return 'lamp-done';
  if (s.status === 'stale') return 'lamp-stale';
  return 'lamp-off';
}

function cardHTML(s) {
  const st = STATUS[s.status];
  const d = s.brief?.decision;
  return `<div class="card ${st.breathe ? 'breathe' : ''}" tabindex="0" data-id="${s.id}" style="--rail:${st.color}">
    <div class="card-top">
      <span class="lamp ${lampClass(s)}" title="${st.label}"></span>
      <span class="card-name">${esc(s.name)}</span>
      <span class="card-proj">${esc(dirTail(s.projectDir))}${s.branch ? ' ⎇' + esc(s.branch) : ''}</span>
      <span class="status-pill" style="--pc:${st.color}">${st.label}</span>
      <span class="card-time" title="进入当前状态的时长">${ago(s.statusChangedAt || s.lastActivityAt)}</span>
    </div>
    <pre class="mini-term" data-id="${s.id}">${s.tailHtml !== undefined && s.tailHtml !== null ? s.tailHtml : esc(s.tailCache || '')}${s.tailHtml || s.tailCache ? '' : esc(s.alive ? '(等待画面…)' : '(未在运行)')}</pre>
    <div class="card-line">${esc(s.statusLine)}<span class="src">${s.brief ? SRC_LABEL[s.brief.source] : '系统观测'}</span></div>
    ${s.status === 'review_ready' && s.worktree ? `<div class="card-review"><button class="review-btn">审阅改动</button></div>` : ''}
    ${d && d.question ? `<div class="card-decision">
      <div class="q">${esc(d.question)}</div>
      <div class="opts">${(d.options || []).map((o) =>
        `<button class="opt-btn ${o === d.recommended ? 'rec' : ''}" data-answer="${esc(o)}">${esc(o)}</button>`).join('')}</div>
    </div>` : ''}
    ${s.status === 'needs_permission' && s.alive ? `<div class="card-decision">
      <div class="opts">
        <button class="opt-btn perm-btn" data-perm="allow" title="向权限对话框发送选项 1(允许)">✓ 批准</button>
        <button class="opt-btn perm-btn deny" data-perm="deny" title="向权限对话框发送 Esc(拒绝)">✗ 拒绝</button>
      </div>
    </div>` : ''}
  </div>`;
}

function renderInbox() {
  main.className = '';
  const inbox = inboxSessions();
  const others = [...state.sessions.values()].filter((s) => !s.archived && s.alive && !INBOX_GROUPS.some(([k]) => k === s.status));
  let html = `<div class="page-head"><h1>Attention Inbox</h1><span class="sub">${inbox.length} 项需要你 · ${others.length} 项在后台推进</span></div>`;
  if (!inbox.length) {
    html += `<div class="empty"><strong>现在没有需要你的事</strong>所有 session 都在推进或已归档。创建新任务,或去 All Sessions 查看运行详情。</div>`;
  }
  for (const [key, title] of INBOX_GROUPS) {
    const list = inbox.filter((s) => s.status === key).sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
    if (!list.length) continue;
    html += `<section class="group"><div class="group-head" style="color:${STATUS[key].color}">${title}<span class="n">${list.length}</span></div>
      <div class="cards">${list.map(cardHTML).join('')}</div></section>`;
  }
  if (others.length) {
    html += `<section class="group"><div class="group-head" style="color:var(--faint)">In progress · 后台推进中<span class="n">${others.length}</span></div>
      <div class="cards">${others.map(cardHTML).join('')}</div></section>`;
  }
  main.innerHTML = html;
  wireCards();
}

function renderSessions() {
  main.className = '';
  const all = [...state.sessions.values()];
  const pass = (s) => {
    if (state.typeFilter !== 'all' && s.type !== state.typeFilter) return false;
    if (state.filter === 'archived') return s.archived;
    if (s.archived) return false;
    if (state.filter === 'attention') return INBOX_GROUPS.some(([k]) => k === s.status);
    if (state.filter === 'active') return true;
    return true;
  };
  const list = all.filter(pass).sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
  const chip = (id, label, group) => {
    const on = group === 'f' ? state.filter === id : state.typeFilter === id;
    return `<button class="chip ${on ? 'on' : ''}" data-${group}="${id}">${label}</button>`;
  };
  main.innerHTML = `<div class="page-head"><h1>All Sessions</h1><span class="sub">共 ${list.length} 条</span></div>
    <div class="filters">
      ${chip('active', '全部活跃', 'f')}${chip('attention', '需要注意', 'f')}${chip('archived', '已归档', 'f')}
      <span style="width:12px"></span>
      ${chip('all', '所有类型', 't')}${chip('claude', 'Claude Code', 't')}${chip('terminal', 'Terminal', 't')}
    </div>
    <div class="cards">${list.map(cardHTML).join('') || '<div class="empty"><strong>没有匹配的 session</strong></div>'}</div>`;
  main.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => { state.filter = b.dataset.f; render(); });
  main.querySelectorAll('[data-t]').forEach((b) => b.onclick = () => { state.typeFilter = b.dataset.t; render(); });
  wireCards();
}

function wireCards(sel = '.card') {
  main.querySelectorAll('.mini-term').forEach((el) => { el.scrollTop = el.scrollHeight; });
  main.querySelectorAll(sel).forEach((el) => {
    el.addEventListener('click', (e) => {
      const rb = e.target.closest('.review-btn');
      if (rb) {
        e.stopPropagation();
        openDiff(el.dataset.id);
        return;
      }
      const btn = e.target.closest('.opt-btn');
      if (btn) {
        e.stopPropagation();
        if (btn.dataset.perm) sendPermission(el.dataset.id, btn.dataset.perm === 'allow');
        else sendDecision(el.dataset.id, btn.dataset.answer);
        return;
      }
      openSession(el.dataset.id);
    });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') openSession(el.dataset.id); });
    bindHover(el, el.dataset.id);
  });
}

async function sendPermission(id, approve) {
  const r = await act(id, approve ? 'approve-permission' : 'deny-permission').catch((e) => ({ error: e.message }));
  toast(r && r.error ? '操作失败:' + r.error : (approve ? '已批准' : '已拒绝'), '', null, 2500);
}

async function sendDecision(id, answer) {
  const s = state.sessions.get(id);
  const question = s?.brief?.decision?.question || null;
  const r = await api(`/api/sessions/${id}/input`, { text: answer, record: { question } });
  toast(r.delivered ? '已发送回原会话' : '发送失败:session 未在运行', answer, () => openSession(id));
}

/* ---------- diff 审阅覆盖层 ---------- */
let diffCtx = null; // { id, data }

async function openDiff(id) {
  popover.hidden = true;
  try {
    const data = await api(`/api/sessions/${id}/diff`);
    diffCtx = { id, data };
    renderDiffOverlay();
  } catch (e) { toast('无法读取改动', e.message); }
}
function closeDiff() {
  const el = $('#diff-overlay');
  if (el) el.remove();
  diffCtx = null;
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDiff(); });

// 单文件着色:+/-/@@ 三色,其余 meta/上下文;全部转义
function diffFileHTML(chunk, i) {
  const lines = chunk.split('\n');
  const m = lines[0].match(/^diff --git a\/.* b\/(.*)$/);
  const fpath = m ? m[1] : lines[0];
  const body = lines.map((l) => {
    let c = 'ctx';
    if (/^(diff --git|index |new file|deleted file|old mode|new mode|copy from|copy to|Binary files|similarity|rename |\+\+\+|---)/.test(l)) c = 'meta';
    else if (l.startsWith('@@')) c = 'hunk';
    else if (l.startsWith('+')) c = 'add';
    else if (l.startsWith('-')) c = 'del';
    return `<span class="dl-${c}">${esc(l)}</span>`;
  }).join('\n');
  const pre = `<pre class="diff-text">${body}</pre>`;
  return `<section class="diff-file" id="dfile-${i}">
    <div class="diff-file-head">${esc(fpath)}</div>
    ${lines.length > 800 ? `<details><summary>${lines.length} 行改动,点击展开</summary>${pre}</details>` : pre}
  </section>`;
}

function renderDiffOverlay() {
  const stale = $('#diff-overlay');
  if (stale) stale.remove();
  const { id, data } = diffCtx || {};
  const s = state.sessions.get(id);
  if (!s || !data) return;
  const totalAdd = data.files.reduce((n, f) => n + (Number(f.add) || 0), 0);
  const totalDel = data.files.reduce((n, f) => n + (Number(f.del) || 0), 0);
  const chunks = data.diff ? data.diff.split(/^(?=diff --git )/m).filter((c) => c.trim()) : [];
  const el = document.createElement('div');
  el.id = 'diff-overlay';
  el.innerHTML = `
    <div class="diff-head">
      <b>${esc(s.name)}</b>
      <span class="diff-branch">${esc(data.branch)} → ${esc(data.target)}</span>
      <span class="diff-stat"><i class="add">+${totalAdd}</i> <i class="del">−${totalDel}</i> · ${data.files.length} 个文件</span>
      ${data.behind ? `<span class="diff-warn">⚠ ${esc(data.target)} 已前进 ${Number(data.behind) || 0} 条提交,可能有冲突</span>` : ''}
      ${data.truncated ? '<span class="diff-warn">diff 过大已截断,完整内容请进终端查看</span>' : ''}
      <span style="flex:1"></span>
      <button class="btn-ghost" id="diff-refresh">刷新</button>
      <button class="btn-primary" id="diff-merge">合并到 ${esc(data.target)}</button>
      <button class="btn-ghost" id="diff-close">关闭</button>
    </div>
    <div id="diff-banner" hidden></div>
    <div class="diff-body">
      <nav class="diff-nav">${data.files.map((f, i) => `
        <a data-i="${i}"><span class="p">${esc(f.path)}</span>
          <span class="n">${f.add == null ? '二进制' : `+${Number(f.add) || 0} −${Number(f.del) || 0}`}</span></a>`).join('')}
      </nav>
      <div class="diff-main">${chunks.map(diffFileHTML).join('') || '<div class="empty"><strong>没有改动</strong></div>'}</div>
    </div>`;
  document.body.appendChild(el);
  $('#diff-close', el).onclick = closeDiff;
  $('#diff-refresh', el).onclick = () => openDiff(id);
  el.querySelectorAll('.diff-nav a').forEach((a) => a.onclick = () => {
    const t = $(`#dfile-${a.dataset.i}`, el);
    if (t) t.scrollIntoView({ behavior: 'smooth' });
  });
  $('#diff-merge', el).onclick = async () => {
    const btn = $('#diff-merge', el);
    btn.disabled = true; btn.textContent = '合并中…';
    try {
      const r = await act(id, 'merge');
      if (r.merged) {
        closeDiff();
        if (confirm(`已合并到 ${r.target}(${r.hash})。\n\n一键收尾:停止该 session、清理 worktree 与分支、归档?\n(会话记录与时间线保留)`)) {
          await act(id, 'finish');
          toast('已收尾', '进程已停止,worktree 与分支已清理,session 已归档', null, 5000);
          closeWorkspace('sessions');
        } else {
          toast(`已合并到 ${r.target}(${r.hash})`, '稍后可在工作区手动归档', null, 5000);
        }
        return;
      }
      if (r.conflict) showConflict(id, r, el);
    } catch (e) {
      toast('合并失败', e.message);
    }
    btn.disabled = false; btn.textContent = `合并到 ${data.target}`;
  };
}

function showConflict(id, r, el) {
  const b = $('#diff-banner', el);
  if (!b) return;
  b.hidden = false;
  b.innerHTML = `<b>合并有冲突,${esc(r.target)} 未被改动。</b>冲突文件:${r.files.map(esc).join('、')}
    <button class="btn-ghost" id="diff-resolve">让 Claude 解决冲突</button>`;
  $('#diff-resolve', el).onclick = async () => {
    try {
      await act(id, 'resolve-conflict', { target: r.target, files: r.files });
      toast('已发送指令', 'Claude 将在其 worktree 中解决冲突,完成后可重新合并');
      closeDiff();
    } catch (e) { toast('发送失败', e.message); }
  };
}

/* ---------- workspace ---------- */
let term = null, fit = null, termWs = null, termRO = null, termRetry = null;
let lastCopy = { text: '', at: 0 };

// 复制当前终端选区。先聚焦终端,保证 execCommand 触发的 copy 事件落在
// xterm 的 textarea 上(由 xterm 内建处理写入剪贴板,无需权限)。
function copyTermSelection() {
  if (!term || !term.hasSelection()) return false;
  const text = term.getSelection();
  const dup = text === lastCopy.text && Date.now() - lastCopy.at < 3000;
  if (dup) return true;
  term.focus();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* 走补充路径 */ }
  if (!ok && navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => { });
  lastCopy = { text, at: Date.now() };
  toast('已复制', text.length > 60 ? text.slice(0, 60) + '…' : text, null, 1600);
  return true;
}
// 选中即复制:在文档层面监听松开鼠标(Option+拖选常在终端容器外松手)。
// 仅当本次手势改变了选区才复制,避免点击页面其他控件时误触发、抢焦点。
let selAtMouseDown = '';
document.addEventListener('mousedown', () => {
  selAtMouseDown = term && term.hasSelection() ? term.getSelection() : '';
});
document.addEventListener('mouseup', () => {
  setTimeout(() => {
    if (!term || !term.hasSelection()) return;
    if (term.getSelection() !== selAtMouseDown) copyTermSelection();
  }, 0);
});

function openSession(id) {
  state.view = 'workspace';
  state.currentId = id;
  render();
}
function closeWorkspace(backTo = 'inbox') {
  disposeTerm();
  state.view = backTo;
  state.currentId = null;
  render();
}
function disposeTerm() {
  clearTimeout(termRetry);
  if (termWs) { termWs.onclose = null; termWs.close(); termWs = null; }
  if (termRO) { termRO.disconnect(); termRO = null; }
  if (term) { term.dispose(); term = null; fit = null; }
}

function renderWorkspace() {
  const s = state.sessions.get(state.currentId);
  if (!s) { closeWorkspace(); return; }
  const existing = $('#term-host');
  if (existing && term) { updatePanels(s); return; } // 增量更新,不动终端

  disposeTerm();
  main.className = 'ws-mode';
  const st = STATUS[s.status];
  main.innerHTML = `<div class="ws">
    <div class="ws-head">
      <button class="back" id="ws-back">← Inbox</button>
      <input class="ws-name" id="ws-name" value="${esc(s.name)}">
      <span class="status-pill" id="ws-pill" style="--pc:${st.color}"><span class="dot"></span>${st.label}</span>
      <span class="ws-meta" id="ws-meta"></span>
      <div class="ws-actions">
        <button class="btn-ghost" id="ws-redraw" title="重连终端并让 TUI 全量重绘,修复画面/尺寸异常">⟳ 刷新画面</button>
        ${s.worktree ? '<button class="btn-ghost" id="ws-review">审阅改动</button>' : ''}
        <button class="btn-ghost" id="ws-refresh">刷新摘要</button>
        <button class="btn-ghost" id="ws-flag">摘要不准确</button>
        <button class="btn-ghost" id="ws-restart">重启</button>
        <button class="btn-ghost" id="ws-stop">停止</button>
        <button class="btn-ghost" id="ws-archive">归档</button>
        <button class="btn-ghost btn-danger" id="ws-delete">删除</button>
      </div>
    </div>
    <div class="ws-body">
      <div class="ws-col left" id="ws-left"></div>
      <div class="ws-term">
        <div class="readonly-bar" id="ro-bar" hidden>只读观察中<button id="ro-take">接管控制</button></div>
        <div id="term-host"></div>
      </div>
      <div class="ws-col right" id="ws-right"></div>
    </div>
  </div>`;

  $('#ws-back').onclick = () => closeWorkspace('inbox');
  $('#ws-redraw').onclick = () => {
    clearTimeout(termRetry);
    if (termWs) { termWs.onclose = null; termWs.close(); }
    if (fit) fit.fit();
    connectTerm(true); // 重连:回放缓冲 + 以当前窗口尺寸重新 resize
    setTimeout(() => act(s.id, 'redraw'), 500); // 抖动 PTY 尺寸触发 SIGWINCH 全量重绘
    toast('已刷新', '终端已重连并请求重绘', null, 2000);
  };
  $('#ws-name').onchange = (e) => act(s.id, 'rename', e.target.value);
  if (s.worktree) $('#ws-review').onclick = () => openDiff(s.id);
  $('#ws-refresh').onclick = () => act(s.id, 'refresh-brief');
  $('#ws-flag').onclick = () => { act(s.id, 'flag-brief'); toast('已记录', '摘要被标记为不准确'); };
  $('#ws-restart').onclick = () => act(s.id, 'restart').then(() => toast('已重启', s.name, null, 2500)).catch((e) => toast('重启失败', e.message));
  $('#ws-stop').onclick = () => act(s.id, 'stop').then(() => toast('已停止', s.name, null, 2500)).catch((e) => toast('停止失败', e.message));
  $('#ws-archive').onclick = () => { act(s.id, 'archive'); closeWorkspace('sessions'); };
  $('#ws-delete').onclick = () => {
    if (confirm(`删除 session「${s.name}」?${s.worktree ? '\n其 worktree 与分支也会被移除。' : ''}`)) {
      act(s.id, 'delete')
        .then(() => toast('已删除', s.name, null, 2500))
        .catch((e) => toast('删除失败', e.message));
      closeWorkspace('sessions');
    }
  };

  // terminal
  term = new Terminal({
    fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Mono", Menlo, "Noto Sans Mono CJK SC", monospace',
    fontSize: 13,
    theme: { background: '#0e1013', foreground: '#d6dae2', cursor: '#e5a83b', selectionBackground: '#3a4150' },
    scrollback: 8000,
    allowProposedApi: true,
    // TUI(如 Claude Code)开启鼠标捕获后,普通拖选被程序拦走;
    // Mac 上按住 Option(⌥)拖选、其他平台按住 Shift 拖选可强制建立选区
    macOptionClickForcesSelection: true,
  });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('#term-host'));
  fit.fit();

  // 普通拖选永远优先于程序的鼠标捕获(Claude Code 等 TUI 默认拦走拖选)。
  // 代价:TUI 收不到鼠标点击/拖拽事件(滚轮不受影响),对键盘驱动的
  // Claude Code 无影响。覆盖的是 xterm 内部方法,升级 xterm 时需复查。
  try {
    term._core._selectionService.shouldForceSelection = () => true;
  } catch { /* xterm 内部结构变化时退回默认:Option/Shift+拖选 */ }

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && e.code === 'KeyC') { copyTermSelection(); return false; }
    if (mod && !e.shiftKey && e.code === 'KeyC' && term.hasSelection()) {
      copyTermSelection();
      term.clearSelection(); // Ctrl+C:先复制,再按才是发中断;Cmd+C 只复制
      return false;
    }
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
      readClipboard().then((t) => t && term.paste(t)); // Cmd+V/Ctrl+V 由 xterm 原生 paste 事件处理
      return false;
    }
    return true;
  });

  let controller = false;
  const connectTerm = (replay) => {
    if (replay && term) term.reset(); // 重连时服务端会整体回放缓冲区,先清屏避免重复
    termWs = new WebSocket(`${WS_BASE}/ws/term/${s.id}`, wsProto());
    termWs.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'data') term.write(m.data);
      else if (m.type === 'role') {
        controller = m.controller;
        $('#ro-bar') && ($('#ro-bar').hidden = controller);
        if (controller && termWs.readyState === 1) termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      } else if (m.type === 'exit') term.write(`\r\n\x1b[90m[进程已退出,code ${m.code}]\x1b[0m\r\n`);
    };
    // 断线自动重连(标签页休眠恢复、网络抖动),无需手动刷新
    termWs.onclose = () => {
      if (state.view !== 'workspace' || state.currentId !== s.id || !term) return;
      term.write('\r\n\x1b[90m[连接断开,2 秒后自动重连…]\x1b[0m\r\n');
      termRetry = setTimeout(() => connectTerm(true), 2000);
    };
  };
  connectTerm(false);
  term.onData((d) => { if (controller && termWs.readyState === 1) termWs.send(JSON.stringify({ type: 'input', data: d })); });
  term.onResize(({ cols, rows }) => { if (controller && termWs.readyState === 1) termWs.send(JSON.stringify({ type: 'resize', cols, rows })); });
  $('#ro-take').onclick = () => termWs.readyState === 1 && termWs.send(JSON.stringify({ type: 'take-control' }));
  termRO = new ResizeObserver(() => fit && fit.fit());
  termRO.observe($('#term-host'));

  updatePanels(s);
}

function updatePanels(s) {
  const st = STATUS[s.status];
  const nameEl = $('#ws-name');
  if (nameEl && document.activeElement !== nameEl && nameEl.value !== s.name) nameEl.value = s.name;
  const pill = $('#ws-pill');
  if (pill) { pill.style.setProperty('--pc', st.color); pill.innerHTML = `<span class="dot ${st.pulse && s.alive ? 'pulse' : ''}"></span>${st.label}`; }
  const meta = $('#ws-meta');
  if (meta) meta.textContent = `${s.type === 'claude' ? 'claude-code' : 'terminal'} · ${s.alive ? 'running' : 'stopped'} · ${ago(s.lastActivityAt)}`;

  const d = s.brief?.decision;
  $('#ws-left').innerHTML = `
    <h4>Brief</h4>${briefHTML(s)}
    ${d && d.question ? `<div class="decision-box">
      <div class="q">${esc(d.question)}</div>
      ${d.reason ? `<div class="why">推荐 ${esc(d.recommended || '')}:${esc(d.reason)}</div>` : ''}
      <div class="opts">${(d.options || []).map((o) => `<button class="opt-btn ${o === d.recommended ? 'rec' : ''}" data-answer="${esc(o)}">${esc(o)}</button>`).join('')}</div>
    </div>` : ''}
    ${s.status === 'needs_permission' && s.alive ? `<div class="decision-box perm">
      <div class="q">${esc(s.statusLine)}</div>
      <div class="opts">
        <button class="opt-btn perm-btn" data-perm="allow" title="向权限对话框发送选项 1(允许)">✓ 批准</button>
        <button class="opt-btn perm-btn deny" data-perm="deny" title="向权限对话框发送 Esc(拒绝)">✗ 拒绝</button>
      </div>
    </div>` : ''}
    <div class="reply"><input id="ws-reply" placeholder="${s.type === 'claude' ? '回复 Claude(回车发送到原会话)' : '向终端发送一行命令'}"><button class="btn-ghost" id="ws-send">发送</button></div>
    <div style="height:16px"></div>
    <h4>Session</h4>
    <dl class="kv">
      <dt>类型</dt><dd>${s.type === 'claude' ? 'Claude Code' : 'Terminal'}</dd>
      ${s.type === 'claude' && s.model ? `<dt>模型</dt><dd>${esc(s.model)}</dd>` : ''}
      ${s.type === 'claude' && s.permissionMode ? `<dt>权限模式</dt><dd>${esc(s.permissionMode)}</dd>` : ''}
      ${s.type === 'claude' && s.extraArgs ? `<dt>附加参数</dt><dd>${esc(s.extraArgs)}</dd>` : ''}
      <dt>项目</dt><dd>${esc(s.projectDir)}</dd>
      ${s.worktree ? `<dt>worktree</dt><dd>${esc(s.worktree)}</dd><dt>分支</dt><dd>${esc(s.branch)}</dd>` : '<dt>隔离</dt><dd>无(直接在项目目录运行)</dd>'}
      ${s.claudeSessionId ? `<dt>对话</dt><dd>可恢复(重启时 --resume ${esc(s.claudeSessionId.slice(0, 8))}…)</dd>` : ''}
      <dt>创建</dt><dd>${new Date(s.createdAt).toLocaleString()}</dd>
      <dt>最后活动</dt><dd>${ago(s.lastActivityAt)}</dd>
      ${s.exitCode !== null ? `<dt>exit</dt><dd>${s.exitCode}</dd>` : ''}
    </dl>
    <h4>手工备注</h4>
    <div class="note-box"><textarea id="ws-note" rows="2" placeholder="给这个 session 写一句备注">${esc(s.note)}</textarea></div>`;

  $('#ws-left').querySelectorAll('.opt-btn').forEach((b) => {
    b.onclick = () => (b.dataset.perm ? sendPermission(s.id, b.dataset.perm === 'allow') : sendDecision(s.id, b.dataset.answer));
  });
  const reply = $('#ws-reply'), send = () => {
    if (!reply.value.trim()) return;
    api(`/api/sessions/${s.id}/input`, { text: reply.value.trim(), record: d ? { question: d.question } : null })
      .then((r) => toast(r.delivered ? '已发送' : '发送失败:session 未在运行', reply.value.trim()));
    reply.value = '';
  };
  reply.onkeydown = (e) => { if (e.key === 'Enter') send(); };
  $('#ws-send').onclick = send;
  $('#ws-note').onchange = (e) => act(s.id, 'note', e.target.value);

  const evs = [...(s.events || [])].reverse().slice(0, 40);
  const dec = [...(s.decisions || [])].reverse();
  $('#ws-right').innerHTML = `
    ${dec.length ? `<h4>决策历史</h4><div class="timeline">${dec.map((x) => `
      <div class="tl-item k-input">
        <div class="tl-time">${new Date(x.at).toLocaleTimeString()}</div>
        <div class="tl-text">${x.question ? `Q:${esc(x.question)}<br>` : ''}A:${esc(x.answer)} ${x.delivered ? '✓已送达' : '✗未送达'}</div>
      </div>`).join('')}</div><div style="height:10px"></div>` : ''}
    <h4>事件时间线</h4>
    <div class="timeline">${evs.map((e) => `
      <div class="tl-item k-${esc(e.kind)}">
        <div class="tl-time">${new Date(e.at).toLocaleTimeString()} <span class="tl-src">· ${esc(e.source)}</span></div>
        <div class="tl-text">${esc(e.text)}${e.count > 1 ? ` <span class="tl-src">×${e.count}</span>` : ''}</div>
      </div>`).join('') || '<div class="tl-item"><div class="tl-text">暂无事件</div></div>'}</div>`;
}

/* ---------- new session dialog ---------- */
const dlg = $('#dlg-new');
$('#btn-new').onclick = async () => {
  dlg.showModal();
  syncTypeUI();
  try {
    const { dirs } = await api('/api/projects');
    $('#proj-list').innerHTML = dirs.map((d) => `<option value="${esc(d)}">`).join('');
    const inp = dlg.querySelector('[name=projectDir]');
    if (!inp.value && dirs[0]) inp.placeholder = dirs[0] + '(留空使用)';
  } catch { /* 列表失败不影响创建 */ }
};
$('#dlg-cancel').onclick = () => dlg.close();

// 目录浏览器:点击逐级进入,git 仓库带标记;手动输入路径仍然可用
let browsePath = null;
async function loadDir(p, fallbackHome = true) {
  try {
    const d = await api('/api/fs' + (p ? '?path=' + encodeURIComponent(p) : ''));
    browsePath = d.path;
    $('#dir-cur').textContent = d.path;
    $('#dir-cur').append(d.isGit ? Object.assign(document.createElement('span'), { className: 'git-badge', textContent: 'git' }) : '');
    const up = $('#dir-up');
    up.disabled = !d.parent;
    up.dataset.parent = d.parent || '';
    $('#dir-list').innerHTML = d.dirs.map((x) =>
      `<button type="button" class="dir-item" data-name="${esc(x.name)}">📁 ${esc(x.name)}${x.isGit ? '<span class="git-badge">git</span>' : ''}</button>`
    ).join('') || '<div class="dir-empty">(没有子目录)</div>';
    $('#dir-list').querySelectorAll('.dir-item').forEach((b) => {
      b.onclick = () => loadDir(browsePath.replace(/\/$/, '') + '/' + b.dataset.name, false);
    });
  } catch (e) {
    if (fallbackHome && p) return loadDir(null, false); // 输入的路径无效时退回主目录
    toast('无法读取目录', e.message);
  }
}
$('#btn-browse').onclick = () => {
  const box = $('#dir-browser');
  box.hidden = !box.hidden;
  if (!box.hidden) loadDir(dlg.querySelector('[name=projectDir]').value.trim() || null);
};
$('#dir-up').onclick = () => $('#dir-up').dataset.parent && loadDir($('#dir-up').dataset.parent, false);
$('#dir-pick').onclick = () => {
  dlg.querySelector('[name=projectDir]').value = browsePath || '';
  $('#dir-browser').hidden = true;
};
function syncTypeUI() {
  const type = new FormData($('#form-new')).get('type');
  $('#field-isolate').style.display = type === 'claude' ? '' : 'none';
  $('#claude-params').style.display = type === 'claude' ? '' : 'none';
  refreshCmdPreview();
}

let cmdPreviewT = null;
function refreshCmdPreview() {
  clearTimeout(cmdPreviewT);
  cmdPreviewT = setTimeout(async () => {
    const f = new FormData($('#form-new'));
    if (f.get('type') !== 'claude') return;
    try {
      const { argv } = await api('/api/preview-command', {
        type: 'claude',
        command: f.get('command'),
        model: f.get('model'),
        permissionMode: f.get('permissionMode'),
        extraArgs: f.get('extraArgs'),
      });
      // 带空格的参数加引号显示
      $('#cmd-preview').textContent = argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
    } catch { /* 预览失败不影响创建 */ }
  }, 200);
}
['input', 'change'].forEach((ev) => $('#form-new').addEventListener(ev, (e) => {
  if (['command', 'model', 'permissionMode', 'extraArgs'].includes(e.target.name)) refreshCmdPreview();
}));
dlg.querySelectorAll('input[name=type]').forEach((r) => r.onchange = syncTypeUI);
$('#form-new').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const s = await api('/api/sessions', {
      type: f.get('type'),
      name: f.get('name'),
      projectDir: f.get('projectDir') || undefined,
      command: f.get('command'),
      isolate: f.get('isolate') === 'on',
      model: f.get('model'),
      permissionMode: f.get('permissionMode'),
      extraArgs: f.get('extraArgs'),
    });
    state.sessions.set(s.id, s); // 立即入库,不等 WS 广播,确保能直接打开
    dlg.close();
    e.target.reset();
    openSession(s.id);
  } catch (err) {
    alert('创建失败:' + err.message);
  }
};

/* ---------- nav & boot ---------- */
document.querySelectorAll('.nav-item').forEach((b) => b.onclick = () => { disposeTerm(); state.view = b.dataset.view; state.currentId = null; render(); });
$('#btn-reload').onclick = () => location.reload();
const dlgSettings = $('#dlg-settings');
$('#btn-settings').onclick = async () => {
  const c = await api('/api/settings');
  dlgSettings.querySelector('[name=feishuWebhook]').value = c.feishuWebhook || '';
  dlgSettings.querySelector('[name=notifyReviewReady]').checked = !!c.notifyReviewReady;
  dlgSettings.showModal();
};
$('#settings-cancel').onclick = () => dlgSettings.close();
$('#settings-test').onclick = async () => {
  await saveSettings();
  const r = await api('/api/settings/test', {});
  toast('测试消息', r.skipped ? '未配置 webhook' : (r.code === 0 || r.StatusCode === 0 ? '已发送,去飞书看看' : '发送失败:' + JSON.stringify(r).slice(0, 80)));
};
async function saveSettings() {
  const f = new FormData($('#form-settings'));
  return api('/api/settings', { feishuWebhook: f.get('feishuWebhook'), notifyReviewReady: f.get('notifyReviewReady') === 'on' });
}
$('#form-settings').onsubmit = async (e) => {
  e.preventDefault();
  try { await saveSettings(); dlgSettings.close(); toast('已保存', '通知设置已更新', null, 2500); }
  catch (err) { toast('保存失败', err.message); }
};
$('#btn-notify').onclick = async () => {
  const p = await Notification.requestPermission();
  toast('桌面通知', p === 'granted' ? '已开启:需要决策/权限/阻塞时会提醒你' : '未授权,仅使用页面内提醒');
};
setInterval(() => { if (state.view !== 'workspace') render(); }, 30_000);
// 若服务端开启 token 认证,先校验令牌再建立连接(WS 被拒时只会静默断开,无法提示)
fetch('/api/health', { headers: authHeaders() }).then((r) => {
  if (r.status === 401) promptToken();
  else { connectEvents(); render(); }
}).catch(() => { connectEvents(); render(); });
