'use strict';
const { EventEmitter } = require('node:events');
const { encodeControl, decodeControl, encodeData, decodeData } = require('./frames');

// 中止事件叫 aborted 而不是 error:EventEmitter 上没人监听的 'error' 会直接抛出
// 打崩进程,而这个事件的触发者是网络对端——不能给对端打崩我们的能力。
class Stream extends EventEmitter {
  constructor(mux, id, meta) {
    super();
    this.mux = mux;
    this.id = id;
    this.meta = meta;
    this.localEnded = false;
    this.remoteEnded = false;
    this.destroyed = false;
  }
  headers(meta) {
    if (this.destroyed || this.localEnded) return;
    this.mux._control({ streamId: this.id, kind: 'headers', meta });
  }
  write(payload) {
    if (this.destroyed || this.localEnded) return;
    this.mux._data(this.id, payload);
  }
  end() {
    if (this.destroyed || this.localEnded) return;
    this.localEnded = true;
    this.mux._control({ streamId: this.id, kind: 'end' });
    this.mux._collect(this);
  }
  fail(message) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.mux._control({ streamId: this.id, kind: 'error', meta: { message: String(message || '未知错误') } });
    this.mux._forget(this.id);
  }
}

class Mux extends EventEmitter {
  constructor({ send, initiator = false } = {}) {
    super();
    if (typeof send !== 'function') throw new Error('Mux 需要 send(payload, isBinary)');
    this._send = send;
    this._streams = new Map();
    // 双方各占一半 id 空间,将来两侧都主动开流也不会撞号
    this._nextId = initiator ? 1 : 2;
  }

  open(meta) {
    const id = this._nextId;
    this._nextId += 2;
    const s = new Stream(this, id, meta === undefined ? null : meta);
    this._streams.set(id, s);
    this._control({ streamId: id, kind: 'open', meta: s.meta });
    return s;
  }

  handleMessage(data, isBinary) {
    if (isBinary) {
      const { streamId, payload } = decodeData(data);
      const s = this._streams.get(streamId);
      if (s && !s.destroyed) s.emit('data', payload);
      return;
    }
    const f = decodeControl(data);
    if (f.kind === 'ping') { this._control({ streamId: 0, kind: 'pong' }); this.emit('ping'); return; }
    if (f.kind === 'pong') { this.emit('pong'); return; }
    if (f.kind === 'open') {
      if (this._streams.has(f.streamId)) return; // 重复 open:忽略,别把已有流冲掉
      const s = new Stream(this, f.streamId, f.meta);
      this._streams.set(f.streamId, s);
      this.emit('stream', s);
      return;
    }
    const s = this._streams.get(f.streamId);
    if (!s) return; // 迟到帧:流已回收,静默丢弃
    if (f.kind === 'headers') { s.emit('headers', f.meta); return; }
    if (f.kind === 'end') { s.remoteEnded = true; s.emit('end'); this._collect(s); return; }
    if (f.kind === 'error') {
      s.destroyed = true;
      this._forget(s.id);
      s.emit('aborted', new Error((f.meta && f.meta.message) || '对端中止了这条流'));
    }
  }

  sendPing() { this._control({ streamId: 0, kind: 'ping' }); }

  closeAll(reason) {
    const streams = [...this._streams.values()];
    this._streams.clear();
    for (const s of streams) {
      if (s.destroyed) continue;
      s.destroyed = true;
      s.emit('aborted', new Error(String(reason || '隧道关闭')));
    }
  }

  streamCount() { return this._streams.size; }

  _control(frame) { this._send(encodeControl(frame), false); }
  _data(streamId, payload) { this._send(encodeData(streamId, payload), true); }
  _collect(s) { if (s.localEnded && s.remoteEnded) this._forget(s.id); }
  _forget(id) { this._streams.delete(id); }
}

module.exports = { Mux, Stream };
