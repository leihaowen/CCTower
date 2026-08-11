import test from 'node:test';
import assert from 'node:assert/strict';
import { centeredOnCursor } from '../src/core/placement.js';

// 实测布局:内置屏是主屏(0,0 起),5K 外接屏挂在左边,占负 x。
const BUILTIN = { position: { x: 0, y: 0 }, size: { width: 3024, height: 1964 } };
const LEFT_5K = { position: { x: -5120, y: 0 }, size: { width: 5120, height: 2880 } };
const MONITORS = [BUILTIN, LEFT_5K];
const WIN = { width: 1280, height: 800 };

test('光标在主屏 → 居中到主屏,坐标非负', () => {
  const p = centeredOnCursor(MONITORS, { x: 1500, y: 900 }, WIN);
  assert.deepEqual(p, { x: Math.round((3024 - 1280) / 2), y: Math.round((1964 - 800) / 2) });
  assert.ok(p.x >= 0 && p.y >= 0);
});

test('光标在负坐标外接屏 → 居中到那块屏,不会被算回主屏', () => {
  const p = centeredOnCursor(MONITORS, { x: -2000, y: 1000 }, WIN);
  assert.equal(p.x, Math.round(-5120 + (5120 - 1280) / 2));
  assert.equal(p.y, Math.round((2880 - 800) / 2));
  assert.ok(p.x < 0, '应落在负坐标屏上');
});

test('两块屏交界:x 取右开区间,归属唯一不重叠', () => {
  // x = -1 属于左屏(-5120..-1),x = 0 属于主屏
  assert.ok(centeredOnCursor(MONITORS, { x: -1, y: 10 }, WIN).x < 0);
  assert.ok(centeredOnCursor(MONITORS, { x: 0, y: 10 }, WIN).x >= 0);
});

test('窗口比屏幕大 → 钳到屏幕左上角,标题栏不会被推出屏外', () => {
  const small = [{ position: { x: -800, y: -600 }, size: { width: 640, height: 480 } }];
  assert.deepEqual(centeredOnCursor(small, { x: -700, y: -500 }, WIN), { x: -800, y: -600 });
});

test('光标不在任何一块屏内 → null,交回系统默认位置', () => {
  assert.equal(centeredOnCursor(MONITORS, { x: 99999, y: 99999 }, WIN), null);
  assert.equal(centeredOnCursor([], { x: 0, y: 0 }, WIN), null);
});

test('入参残缺一律 null,不产出 NaN 坐标', () => {
  assert.equal(centeredOnCursor(null, { x: 0, y: 0 }, WIN), null);
  assert.equal(centeredOnCursor(MONITORS, null, WIN), null);
  assert.equal(centeredOnCursor(MONITORS, { x: 0, y: 0 }, null), null);
  assert.equal(centeredOnCursor(MONITORS, { x: 0, y: NaN }, WIN), null);
  assert.equal(centeredOnCursor([{ position: { x: 0 }, size: { width: 10, height: 10 } }], { x: 0, y: 0 }, WIN), null);
  assert.equal(centeredOnCursor([{ position: { x: 0, y: 0 }, size: { width: 0, height: 10 } }], { x: 0, y: 0 }, WIN), null);
});
