// 隧道故障告警的判定:只推终态与持续故障,短暂抖动不打扰。
// 纯逻辑,时间由 now 参数注入(与 core/tunnel.js 注入 setTimer 同理),便于单测。
//
// 三条规则:
//   1. auth-failed 是终态(重试也不会自己好)→ 立即推,每轮故障只推一次
//   2. 非 up 状态持续 SUSTAINED_MS → 推一次;期间恢复 up 就取消,不推
//   3. 反复进入故障态(窗口内达 FLAP_THRESHOLD 次)→ 推一次"反复重连"
// 规则 3 是为了盖住规则 2 的盲区:隧道在 up 与故障之间高频抖动时,每次 up 都会
// 重置持续计时,单靠规则 2 永远不会告警,而这恰恰是最需要人介入的形态。
//
// 恢复不推通知(按需求"只推终态与持续故障")。

export const SUSTAINED_MS = 60_000;
export const FLAP_WINDOW_MS = 120_000;
export const FLAP_THRESHOLD = 5;

const TERMINAL = new Set(['auth-failed']);

export function createAlertState() { return new Map(); }

function entryFor(state, serverId) {
  if (!state.has(serverId)) {
    state.set(serverId, { since: null, last: null, detail: '', alerted: false, flapAlerted: false, enters: [] });
  }
  return state.get(serverId);
}

/**
 * 记录一次隧道状态变化。返回需要立刻推送的告警 { state, detail } 或 null。
 * 持续型故障不在这里返回——它没有新事件可依附,由 dueAlerts() 到点检查。
 */
export function noteState(alertState, serverId, next, detail, now) {
  const e = entryFor(alertState, serverId);
  e.last = next;
  if (detail) e.detail = detail;

  if (next === 'up') {
    // 恢复:关掉本轮故障,允许下一轮重新告警。
    // enters 与 flapAlerted 都不动——抖动本身就是 up↔故障 来回跳,
    // 在这里清掉的话每跳一次就会重新告警一次,正是要避免的噪音。
    e.since = null;
    e.alerted = false;
    return null;
  }

  if (e.since === null) e.since = now;

  e.enters.push(now);
  e.enters = e.enters.filter((t) => now - t <= FLAP_WINDOW_MS);
  // 窗口内已掉回阈值以下 → 上一轮抖动算平息,允许下一轮重新告警
  if (e.enters.length < FLAP_THRESHOLD) e.flapAlerted = false;

  if (TERMINAL.has(next)) {
    if (e.alerted) return null;
    e.alerted = true;
    return { state: next, detail: e.detail };
  }

  if (e.enters.length >= FLAP_THRESHOLD && !e.flapAlerted) {
    e.flapAlerted = true;
    return { state: 'flapping', detail: e.detail };
  }

  return null;
}

/**
 * 到点检查持续故障。调用方定期调用(故障持续时不会有新的状态变化事件)。
 * 返回 [{ serverId, state, detail }],每轮故障只产出一次。
 */
export function dueAlerts(alertState, now) {
  const out = [];
  for (const [serverId, e] of alertState) {
    if (e.since === null || e.alerted) continue;
    if (now - e.since < SUSTAINED_MS) continue;
    e.alerted = true;
    out.push({ serverId, state: e.last, detail: e.detail });
  }
  return out;
}

export function forgetServer(alertState, serverId) { alertState.delete(serverId); }
