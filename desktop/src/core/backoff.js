// 重连退避:翻倍封顶,不带抖动 —— 单客户端对单服务器,无雷群问题
export function nextDelay(attempt, { base = 1000, cap = 30000 } = {}) {
  if (!Number.isInteger(attempt) || attempt < 0) throw new RangeError('attempt 必须是非负整数');
  return Math.min(base * 2 ** attempt, cap);
}
