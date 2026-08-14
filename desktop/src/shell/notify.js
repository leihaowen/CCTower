// 薄胶水:系统通知封装。文案与 id 由 core/notifyModel.js 决定,这里只跟插件打交道。
import {
  isPermissionGranted, requestPermission, sendNotification, removeActive, onAction,
} from '@tauri-apps/plugin-notification';

let granted = false;

export async function ensurePermission() {
  try {
    granted = (await isPermissionGranted()) || (await requestPermission()) === 'granted';
  } catch (err) {
    console.error('申请通知权限失败:', err);
    granted = false;
  }
  return granted;
}

export function isNotifyGranted() { return granted; }

// 权限没给就别调 sendNotification:插件不报错、系统静默丢弃,反而把"用户拒绝过"
// 这件事藏起来。这里直接短路,由调用方在界面上提示。
export function pushNotification(notification) {
  if (!granted) return false;
  try {
    sendNotification(notification);
    return true;
  } catch (err) {
    console.error('发送通知失败:', err);
    return false;
  }
}

/** 撤掉已经发出去的通知(会话已被处理)。ids 为 notificationId() 算出的 32 位整数。 */
export async function dismissNotifications(ids) {
  if (!granted || !ids || ids.length === 0) return;
  try {
    await removeActive(ids.map((id) => ({ id })));
  } catch (err) {
    console.error('撤销通知失败:', err);
  }
}

/**
 * 注册通知点击回调。回调收到 sendNotification 时带的 extra({ serverId, sessionId })。
 * 注册失败只影响"点通知能不能跳转",不该拖垮启动。
 */
export async function onNotificationClick(handler) {
  try {
    return await onAction((n) => {
      const extra = (n && n.extra) || {};
      Promise.resolve(handler(extra)).catch((err) => console.error('处理通知点击失败:', err));
    });
  } catch (err) {
    console.error('注册通知点击回调失败:', err);
    return null;
  }
}
