// 本地端口分配。
// 纯粹的"跳过已占用"只看进程内的 taken 集合,问不到操作系统;真实的 bind 冲突由
// core/tunnel.js 在 stderr 命中 BIND_CONFLICT_RE 时换端口重试兜底(onPortConflict)。
export function pickPort(taken, { start = 17080, end = 17999 } = {}) {
  for (let p = start; p <= end; p++) if (!taken.has(p)) return p;
  throw new Error(`本地端口区间已耗尽(${start}–${end})`);
}

/**
 * 首次分配端口时先探一探再用。
 *
 * 为什么需要:上一次退出或崩溃留下的孤儿隧道会继续持有某个端口,而它转发的正是
 * CCTower,探活时会答 HTTP —— 这种端口必须跳过。否则 ssh bind 失败秒退,探活又被
 * 孤儿骗成 up,状态灯就会在 up 与 retrying 之间匀速闪烁。
 *
 * probe(port) 返回 true 表示"有人应答",即不可用。探不出来的非 HTTP 占用仍会漏,
 * 那种情况留给 bind 冲突换端口兜底。
 */
export async function pickFreePort(taken, probe, { tries = 8, ...range } = {}) {
  const rejected = new Set(taken);
  for (let i = 0; i < tries; i++) {
    const port = pickPort(rejected, range);
    if (!(await probe(port))) return port;
    rejected.add(port);
  }
  return pickPort(rejected, range); // 连续都有人应答:先给一个,后续靠 bind 冲突换端口
}
