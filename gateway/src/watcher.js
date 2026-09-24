'use strict';
// 与服务端的契约字段见规格"与服务端的契约"节:snapshot / session / notify,
// 其余消息类型(tail 等)一律不解析。逻辑移植自 desktop/src/core/watcher.js(那份是 ESM,
// 跑在 Tauri 里;这里是 CJS,跑在网关里——两套模块系统,复制比强行共用更省事)。
const ATTENTION = new Set(['needs_decision', 'needs_permission', 'blocked', 'review_ready']);

function createState() { return new Map(); }

// resolved:本条消息使哪些会话离开了注意力状态。一期总览不用它,
// 但保留字段是为了二期 Web Push 能据此撤掉已发出的推送。
function applyMessage(state, serverId, msg) {
  if (!state.has(serverId)) state.set(serverId, new Map());
  const sessions = state.get(serverId);
  switch (msg && msg.type) {
    case 'snapshot': {
      const incoming = new Map((msg.sessions || []).map((s) => [s.id, s.status]));
      const resolved = [];
      for (const [id, status] of sessions) {
        if (ATTENTION.has(status) && !ATTENTION.has(incoming.get(id))) resolved.push(id);
      }
      sessions.clear();
      for (const [id, status] of incoming) sessions.set(id, status);
      return { notify: null, resolved };
    }
    case 'session': {
      if (!msg.session) return { notify: null, resolved: [] };
      const { id, deleted, status } = msg.session;
      const wasAttention = ATTENTION.has(sessions.get(id));
      if (deleted) sessions.delete(id);
      else sessions.set(id, status);
      const stillAttention = !deleted && ATTENTION.has(status);
      return { notify: null, resolved: wasAttention && !stillAttention ? [id] : [] };
    }
    case 'notify':
      return {
        notify: { serverId, sessionId: msg.id, name: msg.name, reason: msg.reason, statusLine: msg.statusLine },
        resolved: [],
      };
    default:
      return { notify: null, resolved: [] };
  }
}

function attentionCount(state, serverId) {
  const sessions = state.get(serverId);
  if (!sessions) return 0;
  let n = 0;
  for (const status of sessions.values()) if (ATTENTION.has(status)) n++;
  return n;
}

function totalAttention(state) {
  let n = 0;
  for (const serverId of state.keys()) n += attentionCount(state, serverId);
  return n;
}

function statusCounts(state, serverId) {
  const sessions = state.get(serverId);
  const out = {};
  if (!sessions) return out;
  for (const status of sessions.values()) out[status] = (out[status] || 0) + 1;
  return out;
}

function dropServer(state, serverId) { state.delete(serverId); }

module.exports = { ATTENTION, createState, applyMessage, attentionCount, totalAttention, statusCounts, dropServer };
