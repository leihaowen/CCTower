// 只做确定性的"跳过已占用";真实的 bind 冲突由 tunnel 的退避重试兜底
// (ssh ExitOnForwardFailure 使 bind 失败表现为进程退出 → 换端口重试,见 shell/main.js)
export function pickPort(taken, { start = 17080, end = 17999 } = {}) {
  for (let p = start; p <= end; p++) if (!taken.has(p)) return p;
  throw new Error(`本地端口区间已耗尽(${start}–${end})`);
}
