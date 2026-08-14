'use strict';
const { EventEmitter } = require('node:events');
const { Mux } = require('../../shared/tunnel/mux');
const { unpackWsMessage } = require('../../shared/tunnel/frames');
const { createState, applyMessage, attentionCount, statusCounts, dropServer } = require('./watcher');

const EVENTS_PATH = '/ws/events';

class Hub extends EventEmitter {
  constructor({ store, pingIntervalMs = 15_000, deadAfterMs = 30_000, now = Date.now, autoSweep = true } = {}) {
    super();
    this.store = store;
    this.pingIntervalMs = pingIntervalMs;
    this.deadAfterMs = deadAfterMs;
    this.now = now;
    this.state = createState();
    this._tunnels = new Map();
    this._timer = autoSweep ? setInterval(() => this.sweep(), pingIntervalMs) : null;
    if (this._timer && this._timer.unref) this._timer.unref();
  }

  attach(server, ws) {
    // 同一台服务器重复接入(比如 agent 重启后旧连接还没超时):踢掉旧的,以新为准
    const prev = this._tunnels.get(server.id);
    if (prev) {
      this._tunnels.delete(server.id);
      prev.mux.closeAll('被新连接取代');
      try { prev.ws.close(); } catch { /* 已关 */ }
    }

    const mux = new Mux({
      initiator: true,
      send: (payload, isBinary) => { if (ws.readyState === 1) ws.send(payload, { binary: isBinary }); },
    });
    const tunnel = { id: server.id, ws, mux, lastFrameAt: this.now(), eventsStale: true, retryTimer: null };
    this._tunnels.set(server.id, tunnel);

    ws.on('message', (data, isBinary) => {
      tunnel.lastFrameAt = this.now();
      // 坏帧不该拖垮整条隧道
      try { mux.handleMessage(data, isBinary); } catch { /* 忽略这一帧 */ }
    });
    ws.on('close', () => {
      // 旧连接被踢时是我们主动 close 的,它的 'close' 事件会异步补发过来;
      // 此时 _tunnels 里这个 id 早已指向新连接,绝不能拿旧连接的 close 事件
      // 去 detach 新连接——必须确认自己还是"当前"这条隧道才动手。
      if (this._tunnels.get(server.id) === tunnel) this.detach(server.id);
    });
    ws.on('error', () => { try { ws.close(); } catch { /* 已关 */ } });

    this.store.touch(server.id);
    // 延后一个微任务再订阅:保证 attach() 调用方紧接着做的 open() 抢先把帧
    // 排进发送队列,不被这里的内部订阅流插队(对端按收帧顺序触发 'stream')。
    queueMicrotask(() => this._subscribeEvents(tunnel));
    this.emit('online', server.id);
  }

  detach(serverId) {
    const t = this._tunnels.get(serverId);
    if (!t) return;
    this._tunnels.delete(serverId);
    if (t.retryTimer) clearTimeout(t.retryTimer);
    t.mux.closeAll('隧道断开');
    try { t.ws.close(); } catch { /* 已关 */ }
    dropServer(this.state, serverId); // 掉线后旧计数就是谎言,直接清掉
    this.store.touch(serverId);
    this.emit('offline', serverId);
  }

  isOnline(serverId) { return this._tunnels.has(serverId); }

  open(serverId, meta) {
    const t = this._tunnels.get(serverId);
    if (!t) return null;
    return t.mux.open(meta);
  }

  overview() {
    return this.store.listServers().map((s) => {
      const t = this._tunnels.get(s.id);
      return {
        id: s.id,
        name: s.name,
        online: !!t,
        lastSeenAt: s.lastSeenAt,
        attention: attentionCount(this.state, s.id),
        counts: statusCounts(this.state, s.id),
        stale: !t || t.eventsStale,
      };
    });
  }

  sweep() {
    // 硬性契约:agent 侧判死是 45s,且 agent 自己从不主动发 ping——它完全靠
    // 收到网关的帧来刷新活性。所以这里的心跳周期(默认 15s)必须显著小于
    // 45s,否则一条空闲但健康的隧道会被 agent 误判死并反复重连。

    // 同时:token 吊销意味着 removeServer() 后的隧道不能继续活着。
    // 活着的 agent 会通过 mux.handleMessage() 自动回 pong 来刷新 lastFrameAt,
    // 所以无法依靠 deadAfterMs 超时来清理已吊销的服务器。
    // 因此需要显式检查:如果隧道对应的 server 已从 store 删除,立即 detach。

    let activeServersSet = null;
    try {
      // 用严格读取,避免坏掉的 servers.json 把所有健康隧道误杀
      const servers = this.store.listServersStrict();
      activeServersSet = new Set(servers.map(s => s.id));
    } catch (e) {
      // 读取失败(服务器名单损坏):本轮跳过吊销检查,只做超时判死
      // 这样可以至少保护活着的隧道不被坏文件击杀
      // 待文件修复或网关重启后,下一轮 sweep 才恢复吊销检查
      console.error('[hub.sweep] 服务器名单读取失败,本轮跳过吊销检查:', e.message);
    }

    for (const t of [...this._tunnels.values()]) {
      // 首先检查服务器是否已被删除(token 已吊销)
      // 仅当成功读取服务器名单时才执行此检查
      if (activeServersSet && !activeServersSet.has(t.id)) {
        // token 已吊销,连接不能继续活着——立即断开
        this.detach(t.id);
        continue;
      }

      if (this.now() - t.lastFrameAt > this.deadAfterMs) {
        // TCP 没断但对端已经死了(移动网络切换最常见):主动掐断,让 agent 走重连
        try { t.ws.terminate ? t.ws.terminate() : t.ws.close(); } catch { /* 已关 */ }
        this.detach(t.id);
        continue;
      }
      t.mux.sendPing();
    }
  }

  close() {
    if (this._timer) clearInterval(this._timer);
    for (const id of [...this._tunnels.keys()]) this.detach(id);
  }

  // 总览的数据来源:借同一条隧道订阅各机的 /ws/events。
  // 它与代理通道相互独立——订阅挂了只影响卡片计数,页面照样能点进去用。
  _subscribeEvents(tunnel) {
    if (!this._tunnels.has(tunnel.id) || this._tunnels.get(tunnel.id) !== tunnel) return;
    const stream = tunnel.mux.open({ type: 'ws', path: EVENTS_PATH });
    tunnel.eventsStale = true;
    stream.on('headers', () => { tunnel.eventsStale = false; });
    stream.on('data', (buf) => {
      let text;
      try { text = unpackWsMessage(buf).data.toString('utf8'); } catch { return; }
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      const { notify } = applyMessage(this.state, tunnel.id, msg);
      if (notify) this.emit('notify', notify);
    });
    const retry = () => {
      tunnel.eventsStale = true;
      if (!this._tunnels.has(tunnel.id) || this._tunnels.get(tunnel.id) !== tunnel) return;
      tunnel.retryTimer = setTimeout(() => this._subscribeEvents(tunnel), 5000);
      if (tunnel.retryTimer.unref) tunnel.retryTimer.unref();
    };
    // 'end' 只代表对端(agent 那侧的本机 /ws/events 连接)结束了它那一半;
    // mux 的 _collect 要求 localEnded && remoteEnded 都为真才回收流,而这里从不
    // 调用 stream.end() 的话,localEnded 永远是 false——流会永久残留在两侧 mux
    // 的 _streams 表里(agent 那侧同理:它要收到我们回发的 'end' 控制帧,_collect
    // 才能凑齐两个条件)。补一次 stream.end() 既标记本地结束,也把 'end' 帧发回去,
    // 一次调用同时让网关与 agent 两侧都能正常回收。
    stream.on('end', () => { stream.end(); retry(); });
    stream.on('aborted', retry);
  }
}

module.exports = { Hub };
