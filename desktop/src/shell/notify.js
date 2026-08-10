// 薄胶水:系统通知封装
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';

export async function ensurePermission() {
  if (await isPermissionGranted()) return true;
  return (await requestPermission()) === 'granted';
}

export function pushNotification({ name, reason, statusLine }) {
  sendNotification({ title: `${name} · ${reason}`, body: statusLine || '' });
}
