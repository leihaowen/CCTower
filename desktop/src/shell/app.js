// app.js —— M1 编排:配置 → 隧道 → watcher → 托盘/通知;M2 起再加主窗口(侧栏 + iframe)
import { loadServers } from './store.js';
import { tauriSpawn, sshRun } from './sshExec.js';
import { httpProbe } from './probe.js';
import { connectEvents } from './wsClient.js';
import { ensurePermission, pushNotification } from './notify.js';
import { updateTray } from './tray.js';
import { initMainWindow } from './mainWindow.js';
import { Tunnel } from '../core/tunnel.js';
import { pickPort } from '../core/ports.js';
import { sshStartArgs } from '../core/servers.js';
import { createState, applyMessage, dropServer } from '../core/watcher.js';
import { buildTrayModel } from '../core/trayModel.js';
import { getCurrentWindow } from '@tauri-apps/api/window';

const runtime = {
  servers: [],
  tunnels: new Map(),      // id -> Tunnel
  localPorts: new Map(),   // id -> port
  wsConns: new Map(),      // id -> {close}
  tunnelStates: new Map(), // id -> state
  watcher: createState(),
};

let mainWin = null; // initMainWindow() 的返回值,托盘"打开"要用它把内容区切到对应服务器

export async function startApp() {
  await ensurePermission();
  runtime.servers = await loadServers();
  const taken = new Set();
  for (const server of runtime.servers.filter((s) => s.enabled)) startTunnel(server, taken);
  await refreshTray();
  mainWin = initMainWindow(runtime, { onServersChanged: restartServers });
  await wireWindowHide();
}

function startTunnel(server, taken) {
  const port = pickPort(taken); taken.add(port);
  runtime.localPorts.set(server.id, port);
  const tunnel = new Tunnel({
    server, localPort: port, spawn: tauriSpawn(), probe: httpProbe,
    onState: (state) => onTunnelState(server, state),
  });
  runtime.tunnels.set(server.id, tunnel);
  tunnel.start();
}

function stopServerRuntime(id) {
  const tunnel = runtime.tunnels.get(id);
  if (tunnel) { tunnel.stop(); runtime.tunnels.delete(id); }
  const conn = runtime.wsConns.get(id);
  if (conn) { conn.close(); runtime.wsConns.delete(id); }
  runtime.localPorts.delete(id);
  runtime.tunnelStates.delete(id);
  dropServer(runtime.watcher, id);
}

// 主窗口表单提交后调用:重新读配置,对新增/参数变更(别名或远端端口变了)的服务器
// 重建隧道;对被删除或禁用的服务器停隧道、断 ws、清 watcher 状态。留在编排层,不下沉到 mainWindow.js。
async function restartServers() {
  const prevById = new Map(runtime.servers.map((s) => [s.id, s]));
  const next = await loadServers();
  const nextById = new Map(next.map((s) => [s.id, s]));

  for (const [id, prev] of prevById) {
    if (!prev.enabled) continue;
    const cur = nextById.get(id);
    const changed = cur && cur.enabled && (cur.sshAlias !== prev.sshAlias || cur.remotePort !== prev.remotePort);
    if (!cur || !cur.enabled || changed) stopServerRuntime(id);
  }

  const taken = new Set(runtime.localPorts.values());
  for (const server of next.filter((s) => s.enabled)) {
    if (!runtime.tunnels.has(server.id)) startTunnel(server, taken);
  }

  runtime.servers = next;
  await refreshTray();
}

// 窗口关闭按钮改为隐藏而非退出:交互全靠托盘/通知唤起,退出走托盘菜单的"退出 CCTower"
async function wireWindowHide() {
  const win = getCurrentWindow();
  await win.onCloseRequested((event) => {
    event.preventDefault();
    win.hide();
  });
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
      onOpenWindow: async () => {
        // 托盘顶部的无条件入口:零服务器时也能唤起主窗口去填"添加服务器"表单
        const win = getCurrentWindow();
        await win.show();
        await win.setFocus();
      },
      onOpen: async (id) => {
        // M2:托盘"打开"从 M1 的系统浏览器兜底(@tauri-apps/plugin-shell 的 open())
        // 改为唤起主窗口并切到对应服务器
        const win = getCurrentWindow();
        await win.show();
        await win.setFocus();
        mainWin?.showServer(id);
      },
      onBootstrap: async (id) => {
        const server = runtime.servers.find((s) => s.id === id);
        const { code, stderr } = await sshRun(sshStartArgs(server));
        if (code !== 0) pushNotification({ name: server.name, reason: '启动失败', statusLine: stderr.slice(0, 200) });
      },
    });
  } finally {
    trayBusy = false;
    window.dispatchEvent(new CustomEvent('ccw:changed')); // 通知主窗口侧栏重渲染
  }
}
