'use strict';
// 隧道帧是 gateway 与 agent 之间唯一的语言,编解码错一位整条隧道就哑了,
// 所以这里把每种帧的往返、以及所有会被对端塞进来的坏输入都钉死。
const test = require('node:test');
const assert = require('node:assert');
const {
  encodeControl, decodeControl, encodeData, decodeData,
  packWsMessage, unpackWsMessage,
} = require('../shared/tunnel/frames');

test('控制帧往返:open 帧的 meta 原样保留', () => {
  const frame = { streamId: 7, kind: 'open', meta: { type: 'http', method: 'GET', path: '/api/sessions' } };
  const back = decodeControl(encodeControl(frame));
  assert.deepEqual(back, frame);
});

test('控制帧往返:无 meta 的帧解码后 meta 为 null', () => {
  const back = decodeControl(encodeControl({ streamId: 3, kind: 'end' }));
  assert.deepEqual(back, { streamId: 3, kind: 'end', meta: null });
});

test('控制帧:未知 kind 编码与解码都报错', () => {
  assert.throws(() => encodeControl({ streamId: 1, kind: 'hack' }), /未知帧类型/);
  assert.throws(() => decodeControl('{"streamId":1,"kind":"hack"}'), /未知帧类型/);
});

test('控制帧:非法 streamId 被拒', () => {
  assert.throws(() => encodeControl({ streamId: -1, kind: 'end' }), /streamId/);
  assert.throws(() => decodeControl('{"streamId":1.5,"kind":"end"}'), /streamId/);
  assert.throws(() => decodeControl('{"kind":"end"}'), /streamId/);
});

test('控制帧:坏 JSON 与非对象都报错而不是崩掉', () => {
  assert.throws(() => decodeControl('not json'), /合法 JSON/);
  assert.throws(() => decodeControl('42'), /必须是对象/);
});

test('数据帧往返:大 streamId 与二进制负载都不失真', () => {
  const payload = Buffer.from([0, 1, 2, 255, 254]);
  const { streamId, payload: back } = decodeData(encodeData(4294967295, payload));
  assert.equal(streamId, 4294967295);
  assert.deepEqual(Buffer.from(back), payload);
});

test('数据帧:空负载合法,不足 4 字节报错', () => {
  const { streamId, payload } = decodeData(encodeData(9, Buffer.alloc(0)));
  assert.equal(streamId, 9);
  assert.equal(payload.length, 0);
  assert.throws(() => decodeData(Buffer.from([1, 2])), /不足 4 字节/);
});

test('WS 消息打包保留 text/binary 语义', () => {
  const t = unpackWsMessage(packWsMessage(Buffer.from('你好'), false));
  assert.equal(t.isBinary, false);
  assert.equal(t.data.toString('utf8'), '你好');

  const b = unpackWsMessage(packWsMessage(Buffer.from([7, 8, 9]), true));
  assert.equal(b.isBinary, true);
  assert.deepEqual(Buffer.from(b.data), Buffer.from([7, 8, 9]));
});
