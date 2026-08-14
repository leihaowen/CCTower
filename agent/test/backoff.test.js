'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { nextDelay } = require('../src/backoff');

test('退避:从 base 起翻倍,封顶不再增长', () => {
  assert.equal(nextDelay(0), 1000);
  assert.equal(nextDelay(1), 2000);
  assert.equal(nextDelay(2), 4000);
  assert.equal(nextDelay(5), 30000, '32s 应被 30s 上限截断');
  assert.equal(nextDelay(50), 30000);
});

test('退避:可自定义 base 与 cap,负数 attempt 按 0 处理', () => {
  assert.equal(nextDelay(0, { base: 500, cap: 4000 }), 500);
  assert.equal(nextDelay(3, { base: 500, cap: 4000 }), 4000);
  assert.equal(nextDelay(-3), 1000);
});
