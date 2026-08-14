'use strict';
// 一条 WebSocket 上跑很多逻辑流:控制帧走 text(JSON),数据帧走 binary
//(前 4 字节大端 streamId + 负载)。二进制不套 JSON 是为了让终端流量零拷贝、不膨胀。
const KINDS = new Set(['open', 'headers', 'end', 'error', 'ping', 'pong']);

function assertFrame(streamId, kind) {
  if (!KINDS.has(kind)) throw new Error(`未知帧类型 ${kind}`);
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 4294967295) {
    throw new Error('streamId 必须是 0–4294967295 的整数');
  }
}

function encodeControl(frame) {
  const f = frame || {};
  assertFrame(f.streamId, f.kind);
  return JSON.stringify({ streamId: f.streamId, kind: f.kind, meta: f.meta === undefined ? null : f.meta });
}

function decodeControl(text) {
  let obj;
  try { obj = JSON.parse(typeof text === 'string' ? text : Buffer.from(text).toString('utf8')); }
  catch { throw new Error('控制帧不是合法 JSON'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('控制帧必须是对象');
  assertFrame(obj.streamId, obj.kind);
  return { streamId: obj.streamId, kind: obj.kind, meta: obj.meta === undefined ? null : obj.meta };
}

function encodeData(streamId, payload) {
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 4294967295) {
    throw new Error('streamId 必须是 0–4294967295 的整数');
  }
  // 负载类型必须明确:Buffer、string 或 null/undefined(视为空负载)
  // 拒绝数字、对象等容易导致隐式转换的类型,保证编解码的可靠性
  let body;
  if (Buffer.isBuffer(payload)) {
    body = payload;
  } else if (typeof payload === 'string') {
    body = Buffer.from(payload, 'utf8');
  } else if (payload === null || payload === undefined) {
    body = Buffer.alloc(0);
  } else {
    throw new Error(`负载类型必须是 Buffer、string、null 或 undefined,收到 ${typeof payload}`);
  }
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(streamId, 0);
  return Buffer.concat([head, body]);
}

function decodeData(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 4) throw new Error('数据帧不足 4 字节,缺 streamId 头');
  return { streamId: b.readUInt32BE(0), payload: b.subarray(4) };
}

// 透传浏览器 WebSocket 时,text 与 binary 的区别必须原样送到对端:
// xterm 的输入是 text,终端输出可能是 binary,弄反了页面会显示乱码。
function packWsMessage(data, isBinary) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return Buffer.concat([Buffer.from([isBinary ? 1 : 0]), body]);
}

function unpackWsMessage(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 1) throw new Error('WS 消息缺少 text/binary 标记字节');
  return { data: b.subarray(1), isBinary: b[0] === 1 };
}

module.exports = { encodeControl, decodeControl, encodeData, decodeData, packWsMessage, unpackWsMessage, KINDS };
