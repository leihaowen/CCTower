/* Agent Workbench — 前端(无构建,原生 JS) */
'use strict';

const STATUS = {
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
async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}
const act = (id, op, value) => api(`/api/sessions/${id}/action`, { op, value });

async function readClipboard() {
  try { return await navigator.clipboard.readText(); }
  catch { toast('无法读取剪贴板', '浏览器未授权;请直接用 Ctrl+V 粘贴'); return ''; }
}

/* ---------- websocket: state stream ---------- */
function connectEvents() {
  const ws = new WebSocket(`ws://${location.host}/ws/events`);
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
    } else if (m.type === 'notify') {
      notify(m);
    }
  };
  ws.onclose = () => setTimeout(connectEvents, 1500);
}

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
      <div class="meta"><span>来源:系统观测</span><span>${ago(s.lastActivityAt)}</span></div></div>`;
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
    <div class="meta"><span>来源:${SRC_LABEL[b.source] || b.source}${s.briefFlagged ? ' · 已被标记不准确' : ''}</span><span>${ago(b.updated_at)}</span></div>
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

function cardHTML(s) {
  const st = STATUS[s.status];
  const d = s.brief?.decision;
  return `<div class="card ${st.breathe ? 'breathe' : ''}" tabindex="0" data-id="${s.id}" style="--rail:${st.color}">
    <div class="card-top">
      <span class="card-name">${esc(s.name)}</span>
      <span class="card-proj">${esc(dirTail(s.projectDir))}${s.branch ? ' ⎇' + esc(s.branch) : ''}</span>
      <span class="status-pill" style="--pc:${st.color}"><span class="dot ${st.pulse ? 'pulse' : ''}"></span>${st.label}</span>
      <span class="card-time">${ago(s.lastActivityAt)}</span>
    </div>
    <div class="card-line">${esc(s.statusLine)}<span class="src">${s.brief ? SRC_LABEL[s.brief.source] : '系统观测'}</span></div>
    ${d && d.question ? `<div class="card-decision">
      <div class="q">${esc(d.question)}</div>
      <div class="opts">${(d.options || []).map((o) =>
        `<button class="opt-btn ${o === d.recommended ? 'rec' : ''}" data-answer="${esc(o)}">${esc(o)}</button>`).join('')}</div>
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
    <div class="rows">${list.map((s) => {
      const st = STATUS[s.status];
      return `<div class="row ${s.archived ? 'archived' : ''}" tabindex="0" data-id="${s.id}">
        <span class="dot ${st.pulse && s.alive ? 'pulse' : ''}" style="--pc:${st.color}"></span>
        <span class="r-name">${esc(s.name)}</span>
        <span class="status-pill" style="--pc:${st.color}">${st.label}</span>
        <span class="r-type">${s.type === 'claude' ? 'claude-code' : 'terminal'}${s.branch ? ' ⎇' : ''}</span>
        <span class="r-line">${esc(s.statusLine)}</span>
        <span class="r-time">${ago(s.lastActivityAt)}</span>
      </div>`;
    }).join('') || '<div class="empty"><strong>没有匹配的 session</strong></div>'}</div>`;
  main.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => { state.filter = b.dataset.f; render(); });
  main.querySelectorAll('[data-t]').forEach((b) => b.onclick = () => { state.typeFilter = b.dataset.t; render(); });
  wireCards('.row');
}

function wireCards(sel = '.card') {
  main.querySelectorAll(sel).forEach((el) => {
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('.opt-btn');
      if (btn) {
        e.stopPropagation();
        sendDecision(el.dataset.id, btn.dataset.answer);
        return;
      }
      openSession(el.dataset.id);
    });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') openSession(el.dataset.id); });
    bindHover(el, el.dataset.id);
  });
}

async function sendDecision(id, answer) {
  const s = state.sessions.get(id);
  const question = s?.brief?.decision?.question || null;
  const r = await api(`/api/sessions/${id}/input`, { text: answer, record: { question } });
  toast(r.delivered ? '已发送回原会话' : '发送失败:session 未在运行', answer, () => openSession(id));
}

/* ---------- workspace ---------- */
let term = null, fit = null, termWs = null, termRO = null;
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
  $('#ws-name').onchange = (e) => act(s.id, 'rename', e.target.value);
  $('#ws-refresh').onclick = () => act(s.id, 'refresh-brief');
  $('#ws-flag').onclick = () => { act(s.id, 'flag-brief'); toast('已记录', '摘要被标记为不准确'); };
  $('#ws-restart').onclick = () => act(s.id, 'restart');
  $('#ws-stop').onclick = () => act(s.id, 'stop');
  $('#ws-archive').onclick = () => { act(s.id, 'archive'); closeWorkspace('sessions'); };
  $('#ws-delete').onclick = () => {
    if (confirm(`删除 session「${s.name}」?${s.worktree ? '\n其 worktree 与分支也会被移除。' : ''}`)) {
      act(s.id, 'delete'); closeWorkspace('sessions');
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
  termWs = new WebSocket(`ws://${location.host}/ws/term/${s.id}`);
  termWs.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'data') term.write(m.data);
    else if (m.type === 'role') {
      controller = m.controller;
      $('#ro-bar').hidden = controller;
      if (controller && termWs.readyState === 1) termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    } else if (m.type === 'exit') term.write(`\r\n\x1b[90m[进程已退出,code ${m.code}]\x1b[0m\r\n`);
  };
  termWs.onclose = () => term && term.write('\r\n\x1b[90m[连接断开,刷新页面重连]\x1b[0m\r\n');
  term.onData((d) => { if (controller && termWs.readyState === 1) termWs.send(JSON.stringify({ type: 'input', data: d })); });
  term.onResize(({ cols, rows }) => { if (controller && termWs.readyState === 1) termWs.send(JSON.stringify({ type: 'resize', cols, rows })); });
  $('#ro-take').onclick = () => termWs.readyState === 1 && termWs.send(JSON.stringify({ type: 'take-control' }));
  termRO = new ResizeObserver(() => fit && fit.fit());
  termRO.observe($('#term-host'));

  updatePanels(s);
}

function updatePanels(s) {
  const st = STATUS[s.status];
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
    <div class="reply"><input id="ws-reply" placeholder="${s.type === 'claude' ? '回复 Claude(回车发送到原会话)' : '向终端发送一行命令'}"><button class="btn-ghost" id="ws-send">发送</button></div>
    <div style="height:16px"></div>
    <h4>Session</h4>
    <dl class="kv">
      <dt>类型</dt><dd>${s.type === 'claude' ? 'Claude Code' : 'Terminal'}</dd>
      <dt>项目</dt><dd>${esc(s.projectDir)}</dd>
      ${s.worktree ? `<dt>worktree</dt><dd>${esc(s.worktree)}</dd><dt>分支</dt><dd>${esc(s.branch)}</dd>` : '<dt>隔离</dt><dd>无(直接在项目目录运行)</dd>'}
      <dt>创建</dt><dd>${new Date(s.createdAt).toLocaleString()}</dd>
      <dt>最后活动</dt><dd>${ago(s.lastActivityAt)}</dd>
      ${s.exitCode !== null ? `<dt>exit</dt><dd>${s.exitCode}</dd>` : ''}
    </dl>
    <h4>手工备注</h4>
    <div class="note-box"><textarea id="ws-note" rows="2" placeholder="给这个 session 写一句备注">${esc(s.note)}</textarea></div>`;

  $('#ws-left').querySelectorAll('.opt-btn').forEach((b) => b.onclick = () => sendDecision(s.id, b.dataset.answer));
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
        <div class="tl-text">${esc(e.text)}</div>
      </div>`).join('') || '<div class="tl-item"><div class="tl-text">暂无事件</div></div>'}</div>`;
}

/* ---------- new session dialog ---------- */
const dlg = $('#dlg-new');
$('#btn-new').onclick = () => { dlg.showModal(); syncTypeUI(); };
$('#dlg-cancel').onclick = () => dlg.close();
function syncTypeUI() {
  const type = new FormData($('#form-new')).get('type');
  $('#field-isolate').style.display = type === 'claude' ? '' : 'none';
}
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
    });
    dlg.close();
    e.target.reset();
    openSession(s.id);
  } catch (err) {
    alert('创建失败:' + err.message);
  }
};

/* ---------- nav & boot ---------- */
document.querySelectorAll('.nav-item').forEach((b) => b.onclick = () => { disposeTerm(); state.view = b.dataset.view; state.currentId = null; render(); });
$('#btn-notify').onclick = async () => {
  const p = await Notification.requestPermission();
  toast('桌面通知', p === 'granted' ? '已开启:需要决策/权限/阻塞时会提醒你' : '未授权,仅使用页面内提醒');
};
setInterval(() => { if (state.view !== 'workspace') render(); }, 30_000);
connectEvents();
render();
