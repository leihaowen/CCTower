import test from 'node:test';
import assert from 'node:assert/strict';
import { nextDelay } from '../src/core/backoff.js';

test('指数退避:1s 起步翻倍,封顶 30s', () => {
  assert.equal(nextDelay(0), 1000);
  assert.equal(nextDelay(1), 2000);
  assert.equal(nextDelay(4), 16000);
  assert.equal(nextDelay(5), 30000);
  assert.equal(nextDelay(100), 30000); // 大指数不溢出
});

test('attempt 非法时抛错', () => {
  assert.throws(() => nextDelay(-1), RangeError);
  assert.throws(() => nextDelay(1.5), RangeError);
});
