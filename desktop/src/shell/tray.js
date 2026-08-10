// 薄胶水:从 trayModel 渲染;点服务器项回调 onOpen(id),点启动项回调 onBootstrap(id)
import { TrayIcon } from '@tauri-apps/api/tray';
import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import { defaultWindowIcon } from '@tauri-apps/api/app';
import { exit } from '@tauri-apps/plugin-process';

let tray = null;

export async function updateTray(model, { onOpen, onBootstrap, onOpenWindow }) {
  const items = [];
  // 无条件置顶的入口:首启零服务器时,下方列表为空,这是唯一能唤起主窗口(填写添加服务器表单)的路径
  items.push(await MenuItem.new({ id: 'open-window', text: '打开 CCTower', action: () => onOpenWindow() }));
  items.push(await PredefinedMenuItem.new({ item: 'Separator' }));
  for (const it of model.items) {
    items.push(await MenuItem.new({ id: `open:${it.id}`, text: it.label, action: () => onOpen(it.id) }));
    if (it.canBootstrap) {
      items.push(await MenuItem.new({ id: `boot:${it.id}`, text: `  ↳ 启动 ${it.id} 的 CCTower`, action: () => onBootstrap(it.id) }));
    }
  }
  items.push(await PredefinedMenuItem.new({ item: 'Separator' }));
  items.push(await MenuItem.new({ id: 'quit', text: '退出 CCTower', action: () => exit(0) }));
  const menu = await Menu.new({ items });
  if (!tray) {
    tray = await TrayIcon.new({ icon: await defaultWindowIcon(), menu, tooltip: 'CCTower' });
  } else {
    await tray.setMenu(menu);
  }
  await tray.setTitle(model.badge || null); // macOS:图标旁文字角标;Linux 忽略
}
