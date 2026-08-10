import test from 'node:test';
import assert from 'node:assert/strict';
import { pickPort } from '../src/core/ports.js';

test('pickPort:跳过已占用,取区间内第一个空闲', () => {
  assert.equal(pickPort(new Set()), 17080);
  assert.equal(pickPort(new Set([17080, 17081])), 17082);
});

test('pickPort:区间耗尽抛错', () => {
  const taken = new Set();
  for (let p = 17080; p <= 17999; p++) taken.add(p);
  assert.throws(() => pickPort(taken), /耗尽/);
});
