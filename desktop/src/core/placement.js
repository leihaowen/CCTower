// 唤起主窗口时该把它放在哪块屏上。纯函数:输入显示器列表 / 光标位置 / 窗口尺寸,
// 输出物理像素坐标,不碰 Tauri API,便于单测覆盖多屏与负坐标布局。
//
// 为什么不用 Tauri 的 center():它按"窗口当前所在的显示器"居中,而问题恰恰是窗口
// 停在用户没在看的那块屏上(外接屏常占负坐标),居中后仍在那块屏上。改以光标所在
// 显示器为准——点托盘的那一刻,光标就在用户正看着的屏幕上。

// 显示器条目形如 { position: {x, y}, size: {width, height} },坐标与尺寸均为物理像素。
function isRect(m) {
  return !!m
    && Number.isFinite(m.position?.x) && Number.isFinite(m.position?.y)
    && Number.isFinite(m.size?.width) && Number.isFinite(m.size?.height)
    && m.size.width > 0 && m.size.height > 0;
}

function contains(monitor, point) {
  return point.x >= monitor.position.x
    && point.x < monitor.position.x + monitor.size.width
    && point.y >= monitor.position.y
    && point.y < monitor.position.y + monitor.size.height;
}

/**
 * 在包含光标的显示器上算出窗口居中坐标。
 * 返回 null 表示无法判断(显示器列表为空/条目残缺/光标不在任何一块屏内),
 * 调用方应退回系统默认位置,而不是硬塞一个坐标。
 */
export function centeredOnCursor(monitors, cursor, windowSize) {
  if (!Array.isArray(monitors)) return null;
  if (!Number.isFinite(cursor?.x) || !Number.isFinite(cursor?.y)) return null;
  if (!Number.isFinite(windowSize?.width) || !Number.isFinite(windowSize?.height)) return null;

  const target = monitors.filter(isRect).find((m) => contains(m, cursor));
  if (!target) return null;

  // 窗口比屏幕大时钳到屏幕左上角,避免标题栏被推到屏幕外拖不回来。
  return {
    x: Math.max(target.position.x, Math.round(target.position.x + (target.size.width - windowSize.width) / 2)),
    y: Math.max(target.position.y, Math.round(target.position.y + (target.size.height - windowSize.height) / 2)),
  };
}
