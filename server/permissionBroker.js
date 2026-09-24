'use strict';
// PermissionRequest hook 的挂起请求:hook 以 http 调用进来后不立即回应,等网页作答再回写官方决定 JSON。
// TUI 对话框与 hook 并行竞速(实测 claude 2.1.281):终端先答时 hook 不会被杀,
// 所以由调用方在 PostToolUse / Stop 等信号到来时 release,回空响应(= 无决定)。
const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 590_000; // 略短于 hook 的 600s 超时,主动回空响应而不是被 CLI 取消

function kindOf(toolName) {
  if (toolName === 'AskUserQuestion') return 'question';
  if (toolName === 'ExitPlanMode') return 'plan';
  return 'permission';
}

function clip(s, n = 200) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// 一行摘要:用于状态行、卡片标题与决策时间线
function summarize(toolName, input) {
  const i = input || {};
  if (toolName === 'Bash') return clip(i.command);
  if (toolName === 'AskUserQuestion') return clip((i.questions || []).map((q) => q.question).join(' / '));
  if (toolName === 'ExitPlanMode') return '计划待批准';
  if (i.file_path || i.notebook_path) return clip(i.file_path || i.notebook_path);
  if (i.url) return clip(i.url);
  if (i.query) return clip(i.query);
  return clip(JSON.stringify(i));
}

// 键序无关的序列化,用于比较 PermissionRequest 与 PostToolUse 的 tool_input
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',')}}`;
  return JSON.stringify(v);
}

function clipDeep(v, n = 2000) {
  if (typeof v === 'string') return v.length > n ? `${v.slice(0, n)}…(共 ${v.length} 字符)` : v;
  if (Array.isArray(v)) return v.map((x) => clipDeep(x, n));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipDeep(x, n)]));
  return v;
}

function output(decision) {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

class PermissionBroker {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS, onChange = () => { }, onRelease = () => { } } = {}) {
    this.timeoutMs = timeoutMs;
    this.onChange = onChange; // (sessionId) 挂起列表变化
    this.onRelease = onRelease; // (req, reason) 非网页作答的收尾:timeout | disconnect | 调用方给的原因
    this.pending = new Map(); // requestId -> 内部记录
  }

  open(sessionId, payload, res) {
    const toolName = String((payload && payload.tool_name) || '');
    const input = (payload && payload.tool_input) || {};
    const req = {
      id: crypto.randomBytes(6).toString('hex'),
      sessionId,
      kind: kindOf(toolName),
      toolName,
      input,
      suggestions: Array.isArray(payload && payload.permission_suggestions) ? payload.permission_suggestions : [],
      summary: summarize(toolName, input),
      createdAt: new Date().toISOString(),
    };
    const rec = { req, res, timer: null };
    rec.timer = setTimeout(() => this._finish(rec, null, 'timeout'), this.timeoutMs);
    // hook 连接先断(CLI 取消、服务之外的网络原因):清理,不再回写
    res.on('close', () => { if (this.pending.get(req.id) === rec) this._finish(rec, undefined, 'disconnect'); });
    this.pending.set(req.id, rec);
    this.onChange(sessionId);
    return req;
  }

  list(sessionId) {
    return [...this.pending.values()].filter((r) => r.req.sessionId === sessionId).map((r) => r.req);
  }

  // 推给前端的视图:权限请求的参数里长字符串截断(Write 的整份文件内容不该随每次广播推送);
  // 提问与计划需要完整内容才能作答,原样保留
  publicList(sessionId) {
    return this.list(sessionId).map((r) => (r.kind === 'permission' ? { ...r, input: clipDeep(r.input) } : r));
  }

  get(requestId) {
    const rec = this.pending.get(requestId);
    return rec ? rec.req : null;
  }

  // 网页作答。校验失败抛错且不移除请求;成功返回请求记录
  resolve(requestId, { behavior, answers, message, always } = {}) {
    const rec = this.pending.get(requestId);
    if (!rec) throw new Error('请求不存在或已被处理');
    const { req } = rec;
    let decision;
    if (behavior === 'deny') {
      decision = { behavior: 'deny', message: clip(message, 2000) || '用户在 CCTower 网页上拒绝了这次操作' };
    } else if (behavior === 'allow') {
      decision = { behavior: 'allow' };
      if (req.kind === 'question') {
        decision.updatedInput = { ...req.input, answers: this._answers(req, answers) };
      } else if (req.kind === 'plan') {
        decision.updatedInput = req.input;
      } else if (always) {
        const rules = req.suggestions.filter((s) => s && s.type === 'addRules')
          .map((s) => ({ ...s, destination: 'session' })); // 只在本会话生效,不写进 worktree 的配置文件
        if (rules.length) decision.updatedPermissions = rules;
      }
    } else {
      throw new Error(`未知的 behavior: ${behavior}`);
    }
    this._finish(rec, output(decision), 'resolved');
    return req;
  }

  // 已在别处处理(终端作答、回合结束、进程退出):回空响应。
  // match={toolName,input}:先找同工具同参数,找不到再退而取该会话唯一的同名工具请求。
  release(sessionId, match = null, reason = 'elsewhere') {
    let recs = [...this.pending.values()].filter((r) => r.req.sessionId === sessionId);
    if (match) {
      const same = recs.filter((r) => r.req.toolName === match.toolName);
      const exact = same.filter((r) => stable(r.req.input) === stable(match.input || {}));
      recs = exact.length ? exact.slice(0, 1) : (same.length === 1 ? same : []);
    }
    for (const rec of recs) this._finish(rec, null, reason);
    return recs.map((r) => r.req);
  }

  dispose() {
    for (const rec of [...this.pending.values()]) this._finish(rec, undefined, 'dispose');
  }

  _answers(req, answers) {
    const out = {};
    for (const q of req.input.questions || []) {
      let a = answers && answers[q.question];
      if (Array.isArray(a)) a = a.filter(Boolean).join(', ');
      a = String(a == null ? '' : a).trim();
      if (!a) throw new Error(`问题「${q.question}」还没有回答`);
      out[q.question] = a;
    }
    return out;
  }

  // body: 对象=回写决定;null=回空响应(无决定);undefined=连接已不可用,不回写
  _finish(rec, body, reason) {
    if (this.pending.get(rec.req.id) !== rec) return;
    this.pending.delete(rec.req.id);
    clearTimeout(rec.timer);
    if (body !== undefined && !rec.res.writableEnded) {
      try { body ? rec.res.json(body) : rec.res.end(); } catch { /* 连接已断 */ }
    }
    if (reason !== 'resolved') this.onRelease(rec.req, reason);
    this.onChange(rec.req.sessionId);
  }
}

module.exports = { PermissionBroker, summarize };
