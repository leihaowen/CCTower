// app.js —— M1 编排:配置 → 隧道 → watcher → 托盘/通知
import { loadServers } from './store.js';
import { tauriSpawn, sshRun } from './sshExec.js';
import { httpProbe } from './probe.js';
import { connectEvents } from './wsClient.js';
import { ensurePermission, pushNotification } from './notify.js';
import { updateTray } from './tray.js';
import { Tunnel } from '../core/tunnel.js';
import { pickPort } from '../core/ports.js';
import { sshStartArgs } from '../core/servers.js';
import { createState, applyMessage, dropServer } from '../core/watcher.js';
import { buildTrayModel } from '../core/trayModel.js';
import { open } from '@tauri-apps/plugin-shell'; // 注意:该包导出名是 open,不是 brief 草图里的 openUrl

const runtime = {
  servers: [],
  tunnels: new Map(),      // id -> Tunnel
  localPorts: new Map(),   // id -> port
  wsConns: new Map(),      // id -> {close}
  tunnelStates: new Map(), // id -> state
  watcher: createState(),
};

export async function startApp() {
  await ensurePermission();
  runtime.servers = await loadServers();
  const taken = new Set();
  for (const server of runtime.servers.filter((s) => s.enabled)) {
    const port = pickPort(taken); taken.add(port);
    runtime.localPorts.set(server.id, port);
    const tunnel = new Tunnel({
      server, localPort: port, spawn: tauriSpawn(), probe: httpProbe,
      onState: (state) => onTunnelState(server, state),
    });
    runtime.tunnels.set(server.id, tunnel);
    tunnel.start();
  }
  await refreshTray();
}

function onTunnelState(server, state) {
  runtime.tunnelStates.set(server.id, state);
  if (state === 'up' && !runtime.wsConns.has(server.id)) {
    runtime.wsConns.set(server.id, connectEvents({
      localPort: runtime.localPorts.get(server.id),
      token: server.token,
      onMessage: (msg) => {
        const { notify } = applyMessage(runtime.watcher, server.id, msg);
        if (notify) pushNotification(notify);
        if (msg.type !== 'tail') refreshTray(); // tail 高频且不影响角标
      },
      onDown: () => { dropServer(runtime.watcher, server.id); refreshTray(); },
    }));
  }
  if (state !== 'up' && state !== 'server-down') {
    const conn = runtime.wsConns.get(server.id);
    if (conn) { conn.close(); runtime.wsConns.delete(server.id); }
    dropServer(runtime.watcher, server.id);
  }
  refreshTray();
}

let trayBusy = false;
async function refreshTray() {
  if (trayBusy) return; trayBusy = true;
  try {
    await updateTray(buildTrayModel(runtime.servers, runtime.tunnelStates, runtime.watcher), {
      onOpen: (id) => open(`http://127.0.0.1:${runtime.localPorts.get(id)}/`), // M1:系统浏览器兜底
      onBootstrap: async (id) => {
        const server = runtime.servers.find((s) => s.id === id);
        const { code, stderr } = await sshRun(sshStartArgs(server));
        if (code !== 0) pushNotification({ name: server.name, reason: '启动失败', statusLine: stderr.slice(0, 200) });
      },
    });
  } finally { trayBusy = false; }
}
