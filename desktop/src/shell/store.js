// 薄胶水:用 plugin-store 持久化服务器列表,业务校验全部委托 core/servers.js
import { load } from '@tauri-apps/plugin-store';
import { normalizeServer } from '../core/servers.js';

let store;
async function db() { if (!store) store = await load('servers.json', { autoSave: false }); return store; }

export async function loadServers() {
  const raw = (await (await db()).get('servers')) || [];
  const out = [];
  for (const item of raw) {
    try { out.push(normalizeServer(item)); } catch { /* 损坏条目跳过,不拖垮全部 */ }
  }
  return out;
}

export async function saveServers(list) {
  const s = await db();
  await s.set('servers', list.map(normalizeServer)); // 写入前再过一遍校验
  await s.save();
}
