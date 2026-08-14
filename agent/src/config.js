'use strict';
const fs = require('node:fs');

const DEFAULT_FILE = process.env.CCTOWER_AGENT_CONFIG || '/etc/cctower-agent.json';

function validateConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const gatewayUrl = String(c.gatewayUrl || '').trim();
  if (!/^wss?:\/\/.+/.test(gatewayUrl)) throw new Error('gatewayUrl 必须以 ws:// 或 wss:// 开头,例如 wss://cc.example.com/tunnel');
  const token = String(c.token || '').trim();
  if (token.length < 16) throw new Error('token 缺失或过短(至少 16 字符),请用 gateway/cli.js add-server 生成');
  const localPort = c.localPort === undefined || c.localPort === null || c.localPort === '' ? 7080 : Number(c.localPort);
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error('localPort 必须是 1–65535 的整数');
  // 只有本机 CCTower 设了 CCW_TOKEN 才需要填;回环默认形态下留空即可
  const localToken = c.localToken === undefined || c.localToken === null ? '' : String(c.localToken);
  return { gatewayUrl, token, localPort, localToken };
}

function loadConfig(file = DEFAULT_FILE) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { throw new Error(`读不到配置文件 ${file}`); }
  let raw;
  try { raw = JSON.parse(text); }
  catch { throw new Error(`配置文件不是合法 JSON:${file}`); }
  return validateConfig(raw);
}

module.exports = { loadConfig, validateConfig, DEFAULT_FILE };
