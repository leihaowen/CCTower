import { nextDelay } from './backoff.js';
import { sshTunnelArgs } from './servers.js';

// BatchMode 下认证失败的 stderr 特征。匹配即为终态:重试也不会自己好,
// 需要用户去修 ssh-agent / known_hosts
const AUTH_FAIL_RE = /permission denied|host key verification failed|too many authentication failures/i;
// 本地端口被占的 stderr 特征。ExitOnForwardFailure 让 bind 失败表现为进程立刻退出,
// 常见来源是上一次退出/崩溃留下的孤儿隧道还持有这个端口。
const BIND_CONFLICT_RE = /address already in use|cannot listen to port|could not request local forwarding/i;
const PROBE_INTERVAL = 2000;
const PROBE_GRACE = 3; // 连续失败此数后才判 server-down,容忍启动瞬间的抖动
// 子进程活过这个时长才算"这次启动成功了",退避才归零。秒退一律累计,
// 否则只要有任何东西在本地端口上应答,探活就会把退避一直摁回第一档。
const MIN_UPTIME_MS = 5000;

export class Tunnel {
  constructor({ server, localPort, spawn, probe, onState, delayFn = nextDelay,
    setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t),
    now = () => Date.now(), onPortConflict = null }) {
    this.server = server;
    this.localPort = localPort;
    this.state = 'idle';
    this._spawn = spawn; this._probe = probe; this._onState = onState;
    this._delayFn = delayFn; this._setTimer = setTimer; this._clearTimer = clearTimer;
    this._now = now;
    this._onPortConflict = onPortConflict; // (占用的端口) => 新端口;返回非数字则沿用原端口
    this._startedAt = 0;
    this._attempt = 0; this._probeFails = 0; this._stderrTail = '';
    this._child = null; this._timer = null; this._stopped = false;
    this._gen = 0; // 子进程世代号:探活结果只对发起它的那一代子进程有效,跨重连的过期结果直接丢弃
  }

  start() { this._stopped = false; this._launch(); }

  // 返回 kill 的结果(适配层给的是 Promise),退出应用前要 await 它:
  // 进程一旦消失,来不及杀掉的 ssh 会被系统收养并继续占着本地端口。
  stop() {
    this._stopped = true;
    this._cancelTimer();
    if (this._child) return this._child.kill(); // 收尾在 _onChildExit
    this._set('idle');
    return undefined;
  }

  _set(state, detail = '') {
    if (this.state === state) return;
    this.state = state;
    this._onState(state, detail);
  }

  _launch() {
    this._gen++;
    this._set('connecting');
    this._startedAt = this._now();
    this._stderrTail = ''; this._probeFails = 0;
    this._child = this._spawn(sshTunnelArgs(this.server, this.localPort));
    this._child.onStderr((s) => { this._stderrTail = (this._stderrTail + s).slice(-4096); });
    this._child.onExit(() => this._onChildExit());
    this._scheduleProbe();
  }

  _onChildExit() {
    this._child = null;
    this._cancelTimer();
    if (this._stopped) { this._set('idle'); return; }
    if (AUTH_FAIL_RE.test(this._stderrTail)) { this._set('auth-failed', this._stderrTail.trim()); return; }

    // 端口被别人占着:换端口再试。用同一个端口重试永远好不了——占用方(通常是上次
    // 留下的孤儿隧道)不会自己走,而它还会在探活里冒充"隧道已通"。
    if (BIND_CONFLICT_RE.test(this._stderrTail) && this._onPortConflict) {
      const next = this._onPortConflict(this.localPort);
      if (typeof next === 'number' && next !== this.localPort) this.localPort = next;
    }

    // 活得够久才算启动成功,退避归零
    if (this._now() - this._startedAt >= MIN_UPTIME_MS) this._attempt = 0;
    const delay = this._delayFn(this._attempt++);
    this._set('retrying', `${delay}ms 后重连`);
    this._timer = this._setTimer(() => this._launch(), delay);
  }

  _scheduleProbe() { this._timer = this._setTimer(() => this._runProbe(), this.state === 'connecting' && this._probeFails === 0 ? 0 : PROBE_INTERVAL); }

  async _runProbe() {
    if (this._stopped || !this._child) return;
    const gen = this._gen;
    const ok = await this._probe(this.localPort).catch(() => false);
    // 探活结果只对发起它的那一代子进程有效,跨重连的过期结果直接丢弃
    if (this._stopped || !this._child || gen !== this._gen) return;
    // 注意:探活成功不重置 _attempt。探活只能证明"这个本地端口上有人应答",
    // 证明不了那是我们自己的隧道——别人占着端口时它会一直成功,退避就永远停在
    // 第一档,表现为状态灯匀速闪烁。退避归零改由子进程存活时长决定(见 _onChildExit)。
    if (ok) { this._probeFails = 0; this._set('up'); }
    else if (++this._probeFails >= PROBE_GRACE) this._set('server-down');
    this._scheduleProbe();
  }

  _cancelTimer() { if (this._timer != null) { this._clearTimer(this._timer); this._timer = null; } }
}
