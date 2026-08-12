import test from 'node:test';
import assert from 'node:assert/strict';
import { pickPort, pickFreePort } from '../src/core/ports.js';

test('pickPort:跳过已占用,取区间内第一个空闲', () => {
  assert.equal(pickPort(new Set()), 17080);
  assert.equal(pickPort(new Set([17080, 17081])), 17082);
});

test('pickPort:区间耗尽抛错', () => {
  const taken = new Set();
  for (let p = 17080; p <= 17999; p++) taken.add(p);
  assert.throws(() => pickPort(taken), /耗尽/);
});

// 这几条盖的是实测过的故障:上次退出留下的孤儿隧道还占着 17080,它转发的正是
// CCTower,所以探活会答 200。不跳过的话 ssh bind 失败秒退,而探活又被孤儿骗成 up,
// 状态灯就在 up 与 retrying 之间匀速闪烁。
test('pickFreePort:有人应答的端口要跳过', async () => {
  const answering = new Set([17080, 17081]);
  const probe = async (p) => answering.has(p);
  assert.equal(await pickFreePort(new Set(), probe), 17082);
});

test('pickFreePort:同时避开进程内已分配的端口', async () => {
  const probe = async (p) => p === 17081;
  assert.equal(await pickFreePort(new Set([17080]), probe), 17082);
});

test('pickFreePort:没人应答就用第一个', async () => {
  const probe = async () => false;
  assert.equal(await pickFreePort(new Set(), probe), 17080);
});

test('pickFreePort:连续都被占也要给出端口(交给 bind 冲突兜底,不能抛)', async () => {
  const probe = async () => true;
  const p = await pickFreePort(new Set(), probe, { tries: 3 });
  assert.equal(p, 17083, '探了 17080-17082 都有人应答,应返回下一个候选');
});

test('pickFreePort:探活次数不超过 tries', async () => {
  let calls = 0;
  const probe = async () => { calls++; return true; };
  await pickFreePort(new Set(), probe, { tries: 4 });
  assert.equal(calls, 4);
});
