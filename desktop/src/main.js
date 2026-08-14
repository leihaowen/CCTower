// CCTower desktop shell entry point.
// Tauri glue (window/tray/menu wiring) lives under src/shell/.
import { startApp } from './shell/app.js';
startApp().catch((e) => console.error('启动失败:', e));
