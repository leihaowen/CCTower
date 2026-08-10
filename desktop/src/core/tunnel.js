import { nextDelay } from './backoff.js';
import { sshTunnelArgs } from './servers.js';

// BatchMode 下认证失败的 stderr 特征。匹配即为终态:重试也不会自己好,
// 需要用户去修 ssh-agent / known_hosts
const AUTH_FAIL_RE = /permission denied|host key verification failed|too many authentication failures/i;
const PROBE_INTERVAL = 2000;
const PROBE_GRACE = 3; // 连续失败此数后才判 server-down,容忍启动瞬间的抖动

export class Tunnel {
  constructor({ server, localPort, spawn, probe, onState, delayFn = nextDelay,
    setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t) }) {
    this.server = server;
    this.localPort = localPort;
    this.state = 'idle';
    this._spawn = spawn; this._probe = probe; this._onState = onState;
    this._delayFn = delayFn; this._setTimer = setTimer; this._clearTimer = clearTimer;
    this._attempt = 0; this._probeFails = 0; this._stderrTail = '';
    this._child = null; this._timer = null; this._stopped = false;
    this._gen = 0; // 子进程世代号:探活结果只对发起它的那一代子进程有效,跨重连的过期结果直接丢弃
  }

  start() { this._stopped = false; this._launch(); }

  stop() {
    this._stopped = true;
    this._cancelTimer();
    if (this._child) this._child.kill(); // 收尾在 _onChildExit
    else this._set('idle');
  }

  _set(state, detail = '') {
    if (this.state === state) return;
    this.state = state;
    this._onState(state, detail);
  }

  _launch() {
    this._gen++;
    this._set('connecting');
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
    if (ok) { this._attempt = 0; this._probeFails = 0; this._set('up'); }
    else if (++this._probeFails >= PROBE_GRACE) this._set('server-down');
    this._scheduleProbe();
  }

  _cancelTimer() { if (this._timer != null) { this._clearTimer(this._timer); this._timer = null; } }
}
