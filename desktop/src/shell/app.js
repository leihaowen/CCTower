// app.js —— M1 编排:配置 → 隧道 → watcher → 托盘/通知;M2 起再加主窗口(侧栏 + iframe)
import { loadServers } from './store.js';
import { tauriSpawn, sshRun } from './sshExec.js';
import { httpProbe } from './probe.js';
import { connectEvents } from './wsClient.js';
import { ensurePermission, pushNotification, dismissNotifications, onNotificationClick } from './notify.js';
import { updateTray } from './tray.js';
import { initMainWindow } from './mainWindow.js';
import { Tunnel } from '../core/tunnel.js';
import { pickPort, pickFreePort } from '../core/ports.js';
import { exit } from '@tauri-apps/plugin-process';
import { sshStartArgs } from '../core/servers.js';
import { createState, applyMessage, dropServer } from '../core/watcher.js';
import { buildTrayModel } from '../core/trayModel.js';
import { centeredOnCursor } from '../core/placement.js';
import { sessionNotification, sessionNotificationId, tunnelNotification } from '../core/notifyModel.js';
import { createAlertState, noteState, dueAlerts, forgetServer } from '../core/failureAlert.js';
import { getCurrentWindow, availableMonitors, cursorPosition } from '@tauri-apps/api/window';
import { PhysicalPosition } from '@tauri-apps/api/dpi';
import { listen } from '@tauri-apps/api/event';

const runtime = {
  servers: [],
  tunnels: new Map(),      // id -> Tunnel
  localPorts: new Map(),   // id -> port
  wsConns: new Map(),      // id -> {close}
  tunnelStates: new Map(), // id -> state
  watcher: createState(),
  alerts: createAlertState(), // id -> 故障告警去重状态
  // 通知权限:null=还没问出结果(打包后申请会弹系统对话框,用户没点就一直是 null),
  // false=明确被拒(界面上要提示,否则通知静默失效)。只有 false 才提示,null 不提示。
  notifyGranted: null,
};

// 持续型故障没有新事件可依附,靠定时检查兜出来
const ALERT_TICK_MS = 15_000;
// 退出前留给 kill 落地的时间上限:超时也要退,不能因为一个卡住的 kill 就退不掉
const QUIT_GRACE_MS = 1500;

// 已证实 bind 不上的本地端口(被别的进程占着),重新分配时要避开
const badPorts = new Set();

function portsInUse() {
  return new Set([...runtime.localPorts.values(), ...badPorts]);
}

let mainWin = null; // initMainWindow() 的返回值,托盘"打开"要用它把内容区切到对应服务器
let shownAny = false; // 是否已经往内容区放过页面,避免抢掉用户自己选的那台

// 内容区默认显示第一台隧道已通的服务器。必须等 up:iframe 直连隧道端口,
// 隧道没通时加载会失败,而 iframe 不会自己重试,内容区就一直是错误页。
function showFirstReadyServer() {
  if (shownAny || !mainWin) return;
  const ready = runtime.servers.find((s) => s.enabled && runtime.tunnelStates.get(s.id) === 'up');
  if (!ready) return;
  shownAny = true;
  mainWin.showServer(ready.id);
}

export async function startApp() {
  runtime.servers = await loadServers();
  const taken = new Set();
  for (const server of runtime.servers.filter((s) => s.enabled)) await startTunnel(server, taken);
  await refreshTray();
  mainWin = initMainWindow(runtime, { onServersChanged: restartServers });
  await wireWindowHide();

  // 点通知 → 唤起主窗口并切到出事的那台服务器
  await onNotificationClick(async ({ serverId }) => {
    await revealMainWindow();
    if (serverId) mainWin?.showServer(serverId);
  });

  // 点 Dock/Finder 图标(macOS 的 Reopen,见 src-tauri/src/lib.rs)也要把窗口唤起来
  await listen('ccw:reopen', () => { revealMainWindow(); });

  // 手动启动应用就该看到窗口:visible=false 只是为了先定位再显示,避免白闪与
  // 开在别的显示器上,不是"启动后不给窗口"。托盘常驻靠的是关窗不退出(见 wireWindowHide)。
  await revealMainWindow();
  showFirstReadyServer(); // 隧道可能已经 up 了(探活最快 0ms 就回),补一次

  setInterval(pushDueAlertsSafe, ALERT_TICK_MS);

  // 权限申请在打包后会弹系统对话框,且一直等到用户点选才 resolve——绝不能挡在
  // 隧道与托盘前面(否则用户没点那个框,整个 app 就停在启动第一行)。
  // 故意不 await:结果回来后再回填状态并刷新界面提示。
  ensurePermission().then((ok) => {
    runtime.notifyGranted = ok;
    refreshTray(); // finally 里会派发 ccw:changed,侧栏据此刷新提示条
  });
}

function pushDueAlertsSafe() {
  try {
    pushDueAlerts();
  } catch (err) {
    console.error('故障告警检查失败:', err); // 定时器里出错不该静默中断后续检查
  }
}

function pushDueAlerts() {
  for (const { serverId, state, detail } of dueAlerts(runtime.alerts, Date.now())) {
    const server = runtime.servers.find((s) => s.id === serverId);
    if (!server) continue;
    pushNotification(tunnelNotification({ serverId, serverName: server.name, state, detail }));
  }
}

async function startTunnel(server, taken) {
  // 先探一探再用:被上次退出留下的孤儿隧道占着的端口会答 HTTP,必须跳过
  const port = await pickFreePort(taken, httpProbe);
  taken.add(port);
  runtime.localPorts.set(server.id, port);
  const tunnel = new Tunnel({
    server, localPort: port, spawn: tauriSpawn(), probe: httpProbe,
    onState: (state, detail) => onTunnelState(server, state, detail),
    // ssh 报 bind 冲突时换端口。runtime.localPorts 必须跟着改:WS 连接与 iframe
    // 都按它取端口,不同步的话隧道通了但页面还指着旧端口。
    onPortConflict: (busy) => {
      badPorts.add(busy);
      const next = pickPort(portsInUse());
      runtime.localPorts.set(server.id, next);
      // 已建出来的 iframe 还指着旧端口,拆掉等隧道通了重建
      if (mainWin?.dropServer(server.id)) shownAny = false;
      console.error(`本地端口 ${busy} 被占用,${server.name} 改用 ${next}`);
      return next;
    },
  });
  runtime.tunnels.set(server.id, tunnel);
  tunnel.start();
}

// 托盘"退出 CCTower":先停隧道再退。exit(0) 不会替我们收尾——没杀掉的 ssh 会被
// 系统收养(PPID → 1)继续持有本地端口,下次启动抢不到就会陷入重连循环。
async function quitApp() {
  const kills = [...runtime.tunnels.values()].map((t) => {
    try { return t.stop(); } catch (err) { console.error('停止隧道失败:', err); return null; }
  });
  await Promise.race([
    Promise.allSettled(kills),
    new Promise((resolve) => setTimeout(resolve, QUIT_GRACE_MS)),
  ]);
  await exit(0);
}

function stopServerRuntime(id) {
  const tunnel = runtime.tunnels.get(id);
  if (tunnel) { tunnel.stop(); runtime.tunnels.delete(id); }
  const conn = runtime.wsConns.get(id);
  if (conn) { conn.close(); runtime.wsConns.delete(id); }
  runtime.localPorts.delete(id);
  runtime.tunnelStates.delete(id);
  dropServer(runtime.watcher, id);
  forgetServer(runtime.alerts, id); // 否则删掉又加回来的服务器会带着上一轮的告警去重状态
  // iframe 里写死了即将失效的隧道端口,一起拆掉;它正在显示的话要允许重挑一台
  if (mainWin?.dropServer(id)) shownAny = false;
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

  const taken = portsInUse();
  for (const server of next.filter((s) => s.enabled)) {
    if (!runtime.tunnels.has(server.id)) await startTunnel(server, taken);
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

function onTunnelState(server, state, detail) {
  runtime.tunnelStates.set(server.id, state);

  // 客户端自己失联同样要告警:密钥失效/服务端没起来时,用户只看那个小圆点是看不见的
  const alert = noteState(runtime.alerts, server.id, state, detail, Date.now());
  if (alert) {
    pushNotification(tunnelNotification({
      serverId: server.id, serverName: server.name, state: alert.state, detail: alert.detail,
    }));
  }

  if (state === 'up') showFirstReadyServer();

  if (state === 'up' && !runtime.wsConns.has(server.id)) {
    runtime.wsConns.set(server.id, connectEvents({
      localPort: runtime.localPorts.get(server.id),
      token: server.token,
      onMessage: (msg) => {
        const { notify, resolved } = applyMessage(runtime.watcher, server.id, msg);
        if (notify) pushNotification(sessionNotification(notify));
        // 会话已回到普通状态 → 撤掉那条通知,别让人处理完了还挂在通知中心
        if (resolved.length) {
          dismissNotifications(resolved.map((id) => sessionNotificationId(server.id, id)));
        }
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

// 唤起主窗口:先挪到光标所在的显示器再 show。窗口位置会停在上次的显示器上,
// 多屏时那块屏可能正对着墙——用户点了托盘却什么都没看见,与"没反应"无法区分。
// 定位失败(取不到显示器/光标/权限缺失)不该挡住唤起,退回系统默认位置照样 show。
async function revealMainWindow() {
  const win = getCurrentWindow();
  try {
    const [monitors, cursor, size] = await Promise.all([
      availableMonitors(), cursorPosition(), win.outerSize(),
    ]);
    const at = centeredOnCursor(monitors, cursor, size);
    if (at) await win.setPosition(new PhysicalPosition(at.x, at.y));
  } catch (err) {
    console.error('主窗口定位失败,按系统默认位置显示:', err);
  }
  await win.show();
  await win.setFocus();
  return win;
}

let trayBusy = false;
async function refreshTray() {
  if (trayBusy) return; trayBusy = true;
  try {
    await updateTray(buildTrayModel(runtime.servers, runtime.tunnelStates, runtime.watcher), {
      onOpenWindow: async () => {
        // 托盘顶部的无条件入口:零服务器时也能唤起主窗口去填"添加服务器"表单
        await revealMainWindow();
      },
      onOpen: async (id) => {
        // M2:托盘"打开"从 M1 的系统浏览器兜底(@tauri-apps/plugin-shell 的 open())
        // 改为唤起主窗口并切到对应服务器
        await revealMainWindow();
        shownAny = true; // 用户明确选了,别再被默认逻辑顶掉
        mainWin?.showServer(id);
      },
      onQuit: quitApp,
      onBootstrap: async (id) => {
        const server = runtime.servers.find((s) => s.id === id);
        const { code, stderr } = await sshRun(sshStartArgs(server));
        if (code !== 0) {
          pushNotification(tunnelNotification({
            serverId: id, serverName: server.name, state: '启动失败', detail: stderr,
          }));
        }
      },
    });
  } finally {
    trayBusy = false;
    window.dispatchEvent(new CustomEvent('ccw:changed')); // 通知主窗口侧栏重渲染
  }
}
