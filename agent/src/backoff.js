'use strict';
// 网关重启、网络抖动都会让所有 agent 同时断线;指数退避避免它们一起把网关打垮。
function nextDelay(attempt, { base = 1000, cap = 30000 } = {}) {
  const n = Math.max(0, Number(attempt) || 0);
  return Math.min(cap, base * 2 ** n);
}

module.exports = { nextDelay };
