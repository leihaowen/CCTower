// 与服务端的契约字段见规格"与服务端的契约"节:snapshot / session / notify,
// 其余消息类型(tail 等)一律不解析
export const ATTENTION = new Set(['needs_decision', 'needs_permission', 'blocked', 'review_ready']);

export function createState() { return new Map(); }

export function applyMessage(state, serverId, msg) {
  if (!state.has(serverId)) state.set(serverId, new Map());
  const sessions = state.get(serverId);
  switch (msg && msg.type) {
    case 'snapshot':
      sessions.clear();
      for (const s of msg.sessions || []) sessions.set(s.id, s.status);
      return { notify: null };
    case 'session':
      if (!msg.session) return { notify: null };
      if (msg.session.deleted) sessions.delete(msg.session.id);
      else sessions.set(msg.session.id, msg.session.status);
      return { notify: null };
    case 'notify':
      return { notify: { serverId, sessionId: msg.id, name: msg.name, reason: msg.reason, statusLine: msg.statusLine } };
    default:
      return { notify: null };
  }
}

export function attentionCount(state, serverId) {
  const sessions = state.get(serverId);
  if (!sessions) return 0;
  let n = 0;
  for (const status of sessions.values()) if (ATTENTION.has(status)) n++;
  return n;
}

export function totalAttention(state) {
  let n = 0;
  for (const serverId of state.keys()) n += attentionCount(state, serverId);
  return n;
}

export function dropServer(state, serverId) { state.delete(serverId); }
