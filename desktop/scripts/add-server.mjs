// M1 期间的配置入口:绕过 GUI 直接写 Tauri store 文件。
// store 文件位置:macOS ~/Library/Application Support/com.cctower.desktop/servers.json
//               Linux  ~/.config/com.cctower.desktop/servers.json
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizeServer } from '../src/core/servers.js';

const [alias, name, remotePort, token] = process.argv.slice(2);
if (!alias) { console.error('用法:node scripts/add-server.mjs <sshAlias> [name] [remotePort] [token]'); process.exit(1); }

const dir = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'com.cctower.desktop')
  : path.join(os.homedir(), '.config', 'com.cctower.desktop');
const file = path.join(dir, 'servers.json');

let data = { servers: [] };
try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 首次运行 */ }
const next = normalizeServer({ sshAlias: alias, name, remotePort, token });
data.servers = (data.servers || []).filter((s) => s.id !== next.id).concat(next);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(file, JSON.stringify(data, null, 2));
console.log(`已写入 ${file}:`, next);
