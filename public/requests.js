'use strict';
// 挂起的 hook 请求(权限 / AskUserQuestion / 计划审批)的渲染与作答,Inbox 卡片与会话详情共用。
// 页面会随任意会话变化整块重绘:作答中的选择与输入存在 drafts 里,重绘后照原样恢复(含焦点)。
(function () {
  const drafts = new Map(); // requestId -> { picks:{qi:[label]}, other:{qi:text}, denying, message }
  function draft(id) {
    if (!drafts.has(id)) drafts.set(id, { picks: {}, other: {}, denying: false, message: '' });
    return drafts.get(id);
  }

  function denyRow(r, d, placeholder) {
    if (!d.denying) return '';
    return `<div class="req-deny">
      <input class="req-msg" placeholder="${esc(placeholder)}" value="${esc(d.message)}">
      <button class="opt-btn perm-btn deny" data-act="deny-confirm">确认</button>
      <button class="opt-btn" data-act="deny-cancel">取消</button>
    </div>`;
  }

  function permissionHTML(r, d, compact) {
    const i = r.input || {};
    const always = (r.suggestions || []).some((x) => x && x.type === 'addRules');
    return `<div class="q">请求权限 · <b>${esc(r.toolName)}</b></div>
      <code class="req-sum">${esc(r.summary)}</code>
      ${i.description ? `<div class="why">${esc(i.description)}</div>` : ''}
      ${compact ? '' : `<details class="req-args"><summary>完整参数</summary><pre>${esc(JSON.stringify(i, null, 2))}</pre></details>`}
      <div class="opts">
        <button class="opt-btn perm-btn" data-act="allow">✓ 批准</button>
        ${always ? '<button class="opt-btn perm-btn" data-act="always" title="本会话内同类操作不再询问(不写入配置文件)">✓ 本会话总是允许</button>' : ''}
        ${d.denying ? '' : '<button class="opt-btn perm-btn deny" data-act="deny">✗ 拒绝</button>'}
      </div>
      ${denyRow(r, d, '拒绝理由(可选,Claude 会看到)')}`;
  }

  function questionHTML(r, d) {
    const qs = (r.input && r.input.questions) || [];
    const quick = qs.length === 1 && !qs[0].multiSelect; // 单题单选:点选项即提交
    return qs.map((q, qi) => {
      const picks = d.picks[qi] || [];
      return `<div class="req-q">
        ${q.header ? `<span class="req-h">${esc(q.header)}</span>` : ''}${esc(q.question)}${q.multiSelect ? '<span class="req-hint">(可多选)</span>' : ''}
      </div>
      <div class="opts">${(q.options || []).map((o) => `<button class="opt-btn ${picks.includes(o.label) ? 'on' : ''}" data-act="pick" data-q="${qi}" data-label="${esc(o.label)}" title="${esc(o.description || '')}">${esc(o.label)}</button>`).join('')}</div>
      <input class="req-other" data-q="${qi}" placeholder="其他(自由输入${quick ? ',回车提交' : ''})" value="${esc(d.other[qi] || '')}">`;
    }).join('') + `<div class="opts req-foot">
      ${quick ? '' : '<button class="opt-btn perm-btn" data-act="submit">提交回答</button>'}
      ${d.denying ? '' : '<button class="opt-btn" data-act="deny" title="不回答,告诉 Claude 你的想法">不回答</button>'}
    </div>
    ${denyRow(r, d, '想对 Claude 说的话(可选)')}`;
  }

  function planHTML(r, d) {
    return `<div class="q">计划待批准</div>
      <pre class="req-plan">${esc((r.input && r.input.plan) || '(计划内容为空)')}</pre>
      <div class="opts">
        <button class="opt-btn perm-btn" data-act="allow">✓ 批准计划</button>
        ${d.denying ? '' : '<button class="opt-btn perm-btn deny" data-act="deny">✗ 驳回</button>'}
      </div>
      ${denyRow(r, d, '驳回意见(Claude 会据此修改计划)')}`;
  }

  // 会话的全部挂起请求;compact=Inbox 卡片(不展开完整参数)
  function html(s, { compact = false } = {}) {
    return (s.pendingRequests || []).map((r) => {
      const d = draft(r.id);
      const body = r.kind === 'question' ? questionHTML(r, d) : r.kind === 'plan' ? planHTML(r, d) : permissionHTML(r, d, compact);
      const box = compact ? 'card-decision' : `decision-box${r.kind === 'permission' ? ' perm' : ''}`;
      return `<div class="req ${box}" data-req="${r.id}" data-sid="${s.id}">${body}</div>`;
    }).join('');
  }

  function findReq(sid, reqId) {
    const s = state.sessions.get(sid);
    return s && (s.pendingRequests || []).find((r) => r.id === reqId);
  }

  function collectAnswers(r, d) {
    const answers = {};
    const missing = [];
    (r.input.questions || []).forEach((q, qi) => {
      const other = (d.other[qi] || '').trim();
      const picks = d.picks[qi] || [];
      const a = q.multiSelect ? [...picks, ...(other ? [other] : [])] : (other || picks[0] || '');
      if (!a.length) missing.push(q.header || q.question);
      answers[q.question] = a;
    });
    return { answers, missing };
  }

  async function submit(sid, reqId, body) {
    try {
      await act(sid, 'resolve-request', { requestId: reqId, ...body });
      drafts.delete(reqId);
      toast(body.behavior === 'deny' ? '已拒绝' : '已提交', '', null, 2500);
    } catch (e) {
      toast('提交失败', e.message);
    }
  }

  function rerender() { render(); }

  function submitQuestion(sid, r, d) {
    const { answers, missing } = collectAnswers(r, d);
    if (missing.length) { toast('还有问题没回答', missing.join('、'), null, 3000); return; }
    submit(sid, r.id, { behavior: 'allow', answers });
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.req [data-act]');
    if (!btn) return;
    const box = btn.closest('.req');
    const sid = box.dataset.sid;
    const r = findReq(sid, box.dataset.req);
    if (!r) return;
    const d = draft(r.id);
    switch (btn.dataset.act) {
      case 'allow': submit(sid, r.id, { behavior: 'allow' }); break;
      case 'always': submit(sid, r.id, { behavior: 'allow', always: true }); break;
      case 'deny': d.denying = true; rerender(); focusIn(r.id, '.req-msg'); break;
      case 'deny-cancel': d.denying = false; d.message = ''; rerender(); break;
      case 'deny-confirm': submit(sid, r.id, { behavior: 'deny', message: d.message.trim() }); break;
      case 'submit': submitQuestion(sid, r, d); break;
      case 'pick': {
        const qi = Number(btn.dataset.q);
        const q = r.input.questions[qi];
        const label = btn.dataset.label;
        const picks = d.picks[qi] || [];
        if (q.multiSelect) d.picks[qi] = picks.includes(label) ? picks.filter((x) => x !== label) : [...picks, label];
        else d.picks[qi] = [label];
        if (r.input.questions.length === 1 && !q.multiSelect && !(d.other[qi] || '').trim()) { submitQuestion(sid, r, d); break; }
        rerender();
        break;
      }
    }
  });

  document.addEventListener('input', (e) => {
    const box = e.target.closest('.req');
    if (!box) return;
    const d = draft(box.dataset.req);
    if (e.target.classList.contains('req-other')) d.other[e.target.dataset.q] = e.target.value;
    else if (e.target.classList.contains('req-msg')) d.message = e.target.value;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.closest('.req')) return;
    const box = e.target.closest('.req');
    const r = findReq(box.dataset.sid, box.dataset.req);
    if (!r) return;
    e.stopPropagation(); // 别让卡片把回车当成"打开会话"
    const d = draft(r.id);
    if (e.target.classList.contains('req-msg')) submit(box.dataset.sid, r.id, { behavior: 'deny', message: d.message.trim() });
    else if (e.target.classList.contains('req-other')) submitQuestion(box.dataset.sid, r, d);
  }, true);

  function focusIn(reqId, sel) {
    const el = document.querySelector(`.req[data-req="${reqId}"] ${sel}`);
    if (el) el.focus();
  }

  // 重绘前记下焦点所在输入框,重绘后恢复(否则每次广播都会打断输入)
  function captureFocus() {
    const el = document.activeElement;
    const box = el && el.closest && el.closest('.req');
    if (!box || el.tagName !== 'INPUT') return null;
    return { req: box.dataset.req, cls: el.className, q: el.dataset.q, pos: el.selectionStart };
  }
  function restoreFocus(f) {
    if (!f) return;
    const sel = `.req[data-req="${f.req}"] input.${f.cls.split(' ')[0]}${f.q !== undefined ? `[data-q="${f.q}"]` : ''}`;
    const el = document.querySelector(sel);
    if (!el) return;
    el.focus();
    try { el.setSelectionRange(f.pos, f.pos); } catch { /* 非文本输入 */ }
  }

  // 已不存在的请求的草稿清掉,防止无限增长
  function prune() {
    const live = new Set();
    for (const s of state.sessions.values()) for (const r of s.pendingRequests || []) live.add(r.id);
    for (const id of drafts.keys()) if (!live.has(id)) drafts.delete(id);
  }

  window.CCRequests = { html, captureFocus, restoreFocus, prune };
})();
