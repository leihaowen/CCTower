'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const pty = require('node-pty');
const { writeHookSettings, protocolPrompt } = require('./claudeSetup');

const ATTENTION = new Set(['needs_decision', 'needs_permission', 'blocked', 'review_ready']);
const BUFFER_CAP = 200_000;
const STALE_MS = 10 * 60 * 1000;

class SessionManager {
  constructor({ dataDir, baseUrl, onChange, onNotify }) {
    this.dataDir = dataDir;
    this.baseUrl = baseUrl;
    this.onChange = onChange; // (session) => void, broadcast state
    this.onNotify = onNotify; // (session, reason) => void, push notification
    this.sessions = new Map(); // id -> session (persisted shape)
    this.runtime = new Map(); // id -> { pty, buffer, clients:Set<ws>, controller:ws|null }
    fs.mkdirSync(path.join(dataDir, 'worktrees'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'hooks'), { recursive: true });
    this.stateFile = path.join(dataDir, 'sessions.json');
    this._load();
    this._staleTimer = setInterval(() => this._checkStale(), 30_000);
  }

  _load() {
    try {
      const arr = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      for (const s of arr) {
        // The server process owns the PTYs; after a restart they are gone.
        if (s.alive) {
          s.alive = false;
          if (!['completed', 'exited'].includes(s.status)) {
            s.status = 'exited';
            s.statusLine = '服务重启,原进程已结束;可点击「重启」继续';
          }
        }
        this.sessions.set(s.id, s);
      }
    } catch { /* first boot */ }
  }

  _save() {
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => {
      const arr = [...this.sessions.values()];
      fs.writeFileSync(this.stateFile, JSON.stringify(arr, null, 2));
    }, 200);
  }

  list() { return [...this.sessions.values()]; }
  get(id) { return this.sessions.get(id); }

  _touch(s, opts = {}) {
    s.lastActivityAt = new Date().toISOString();
    this._save();
    if (!opts.silent) this.onChange(s);
  }

  _event(s, kind, text, source = '系统观测') {
    s.events.push({ at: new Date().toISOString(), kind, text, source });
    if (s.events.length > 200) s.events.splice(0, s.events.length - 200);
  }

  _setStatus(s, status, statusLine, source = '系统观测') {
    const changed = s.status !== status || s.statusLine !== statusLine;
    s.status = status;
    if (statusLine) s.statusLine = statusLine;
    if (changed) this._event(s, 'status', `${status} — ${s.statusLine}`, source);
    if (ATTENTION.has(status)) {
      const reason = `${status}:${s.statusLine}`;
      if (s.lastNotified !== reason) {
        s.lastNotified = reason;
        this.onNotify(s, status);
      }
    } else {
      s.lastNotified = null; // 状态变化解除去重
    }
    this._touch(s);
  }

  // ---------- creation ----------

  createSession({ name, type, projectDir, command, isolate }) {
    const id = crypto.randomBytes(5).toString('hex');
    projectDir = path.resolve(projectDir || process.cwd());
    if (!fs.existsSync(projectDir)) throw new Error(`目录不存在: ${projectDir}`);
    const s = {
      id,
      name: name || (type === 'claude' ? `Claude ${id.slice(0, 4)}` : `Terminal ${id.slice(0, 4)}`),
      type, // 'terminal' | 'claude'
      projectDir,
      cwd: projectDir,
      command: command || '',
      isolate: type === 'claude' ? isolate !== false : false,
      worktree: null,
      branch: null,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      lastOutputAt: null,
      status: type === 'claude' ? 'executing' : 'terminal_only',
      statusLine: type === 'claude' ? '正在启动 Claude Code…' : '普通终端,语义未知',
      alive: false,
      exitCode: null,
      archived: false,
      note: '',
      brief: null,
      briefFlagged: false,
      events: [],
      decisions: [],
      lastNotified: null,
    };
    if (s.type === 'claude' && s.isolate) this._setupWorktree(s);
    this.sessions.set(id, s);
    this._event(s, 'lifecycle', `创建 session(${s.type}),目录 ${s.cwd}`);
    this._spawn(s);
    this._touch(s);
    return s;
  }

  _setupWorktree(s) {
    const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      const inside = git(['rev-parse', '--is-inside-work-tree'], s.projectDir);
      if (inside !== 'true') throw new Error('not a git repo');
      git(['rev-parse', 'HEAD'], s.projectDir); // requires at least one commit
      const branch = `ccw/${s.id}`;
      const wt = path.join(this.dataDir, 'worktrees', s.id);
      git(['worktree', 'add', wt, '-b', branch], s.projectDir);
      s.worktree = wt;
      s.branch = branch;
      s.cwd = wt;
      this._event(s, 'lifecycle', `已创建独立 worktree(分支 ${branch}),文件改动与其他 session 隔离`);
    } catch (e) {
      s.isolate = false;
      this._event(s, 'warning', `未能创建 worktree(${String(e.message).split('\n')[0]}),已降级为直接在项目目录运行;并行写入同一目录可能互相冲突`);
    }
  }

  _spawn(s) {
    let file, args;
    const env = { ...process.env, CCW_SESSION_ID: s.id, CCW_BASE_URL: this.baseUrl };
    if (s.type === 'claude') {
      const hooksFile = writeHookSettings(path.join(this.dataDir, 'hooks'), this.baseUrl, s.id);
      file = 'claude';
      args = ['--settings', hooksFile, '--append-system-prompt', protocolPrompt(this.baseUrl, s.id)];
      if (s.command) args.push(s.command);
    } else {
      file = process.env.SHELL || 'bash';
      args = [];
    }
    const p = pty.spawn(file, args, {
      name: 'xterm-256color', cols: 120, rows: 32, cwd: s.cwd, env,
    });
    const rt = { pty: p, buffer: '', clients: new Set(), controller: null };
    this.runtime.set(s.id, rt);
    s.alive = true;
    s.exitCode = null;

    p.onData((data) => {
      rt.buffer = (rt.buffer + data).slice(-BUFFER_CAP);
      s.lastOutputAt = new Date().toISOString();
      if (s.status === 'stale') {
        this._setStatus(s, s.type === 'claude' ? 'executing' : 'terminal_only', '恢复输出');
      } else {
        s.lastActivityAt = s.lastOutputAt;
        this._save();
      }
      for (const ws of rt.clients) {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', data }));
      }
    });

    p.onExit(({ exitCode }) => {
      s.alive = false;
      s.exitCode = exitCode;
      this._event(s, 'lifecycle', `进程退出,exit code ${exitCode}`);
      if (s.type === 'claude') {
        if (exitCode === 0) this._setStatus(s, 'completed', 'Claude 会话已结束');
        else this._setStatus(s, 'blocked', `Claude 进程异常退出(code ${exitCode})`);
      } else {
        this._setStatus(s, 'exited', `进程已退出(code ${exitCode})`);
      }
      for (const ws of rt.clients) {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
      }
    });

    if (s.type === 'terminal' && s.command) {
      setTimeout(() => { try { p.write(s.command + '\r'); } catch { } }, 300);
    }
  }

  // ---------- terminal wiring ----------

  attach(id, ws) {
    const rt = this.runtime.get(id);
    const s = this.sessions.get(id);
    if (!s) { ws.close(); return; }
    if (!rt) {
      ws.send(JSON.stringify({ type: 'data', data: '\r\n\x1b[33m[session 未在运行,请点击重启]\x1b[0m\r\n' }));
      ws.send(JSON.stringify({ type: 'role', controller: false }));
      return;
    }
    rt.clients.add(ws);
    if (!rt.controller || rt.controller.readyState !== 1) rt.controller = ws;
    ws.send(JSON.stringify({ type: 'data', data: rt.buffer }));
    ws.send(JSON.stringify({ type: 'role', controller: rt.controller === ws }));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'input') {
        if (rt.controller === ws && s.alive) rt.pty.write(m.data);
      } else if (m.type === 'resize') {
        if (rt.controller === ws && s.alive) { try { rt.pty.resize(m.cols, m.rows); } catch { } }
      } else if (m.type === 'take-control') {
        const prev = rt.controller;
        rt.controller = ws;
        for (const c of rt.clients) {
          if (c.readyState === 1) c.send(JSON.stringify({ type: 'role', controller: c === ws }));
        }
        void prev;
      }
    });
    ws.on('close', () => {
      rt.clients.delete(ws);
      if (rt.controller === ws) {
        rt.controller = [...rt.clients][0] || null;
        if (rt.controller && rt.controller.readyState === 1) {
          rt.controller.send(JSON.stringify({ type: 'role', controller: true }));
        }
      }
    });
  }

  // Programmatic input (decision replies, quick answers). Returns false if dead.
  sendInput(id, text, { record = null } = {}) {
    const s = this.sessions.get(id);
    const rt = this.runtime.get(id);
    if (!s || !rt || !s.alive) return false;
    rt.pty.write(text);
    setTimeout(() => { try { rt.pty.write('\r'); } catch { } }, 120);
    this._event(s, 'input', `用户从网页发送输入:${text.slice(0, 120)}`, '用户操作');
    if (record) {
      s.decisions.push({ at: new Date().toISOString(), question: record.question || null, answer: text, delivered: true });
    }
    // 用户已回应 → 解除通知去重,状态回到执行中
    s.lastNotified = null;
    if (s.type === 'claude') {
      if (s.brief && s.brief.decision) s.brief.decision = null;
      this._setStatus(s, 'executing', '已收到用户输入,继续执行', '用户操作');
    } else {
      this._touch(s);
    }
    return true;
  }

  // ---------- claude signals ----------

  applyHook(id, event, payload) {
    const s = this.sessions.get(id);
    if (!s || s.type !== 'claude') return;
    const msg = (payload && (payload.message || payload.title)) || '';
    this._event(s, 'hook', `${event}${msg ? ':' + msg : ''}`);
    switch (event) {
      case 'Notification': {
        const low = msg.toLowerCase();
        if (low.includes('permission') || msg.includes('权限')) {
          this._setStatus(s, 'needs_permission', msg || 'Claude 请求批准一项敏感操作');
        } else if (low.includes('waiting') || msg.includes('等待')) {
          this._setStatus(s, 'needs_decision', 'Claude 正在等待你的回答');
        } else if (msg) {
          this._setStatus(s, s.status, msg);
        }
        break;
      }
      case 'UserPromptSubmit':
        if (s.brief && s.brief.decision) s.brief.decision = null;
        this._setStatus(s, 'executing', '用户已提交新指令,Claude 继续工作');
        break;
      case 'Stop': {
        if (s.brief && s.brief.decision && s.brief.decision.question) {
          this._setStatus(s, 'needs_decision', `需要你决定:${s.brief.decision.question}`, 'Agent 上报');
        } else if (s.brief && s.brief.blocker) {
          this._setStatus(s, 'blocked', `阻塞:${s.brief.blocker}`, 'Agent 上报');
        } else {
          this._setStatus(s, 'review_ready', '本轮已结束,结果等待你审核');
        }
        break;
      }
      case 'SubagentStop':
        this._touch(s);
        break;
      case 'SessionEnd':
        this._touch(s);
        break;
      default:
        this._touch(s);
    }
  }

  applyReport(id, r) {
    const s = this.sessions.get(id);
    if (!s || s.type !== 'claude') return false;
    s.brief = {
      objective: r.objective || (s.brief && s.brief.objective) || '',
      phase: r.phase || 'executing',
      progress: r.progress || null,
      completed: Array.isArray(r.completed) ? r.completed.slice(0, 10) : [],
      blocker: r.blocker || null,
      decision: r.decision && r.decision.question ? r.decision : null,
      next_action: r.next_action || '',
      evidence: Array.isArray(r.evidence) ? r.evidence.slice(0, 10) : [],
      source: 'agent_reported',
      updated_at: new Date().toISOString(),
    };
    s.briefFlagged = false;
    this._event(s, 'report', `Agent 上报:phase=${s.brief.phase}${s.brief.decision ? ',需要决策' : ''}${s.brief.blocker ? ',有阻塞' : ''}`, 'Agent 上报');
    if (s.brief.decision) {
      this._setStatus(s, 'needs_decision', `需要你决定:${s.brief.decision.question}`, 'Agent 上报');
    } else if (s.brief.blocker) {
      this._setStatus(s, 'blocked', `阻塞:${s.brief.blocker}`, 'Agent 上报');
    } else if (s.brief.phase === 'verifying') {
      this._setStatus(s, 'verifying', s.brief.next_action || '正在测试或验证', 'Agent 上报');
    } else if (s.brief.phase === 'review') {
      this._setStatus(s, 'review_ready', s.brief.next_action || '已完成,等待审核', 'Agent 上报');
    } else {
      this._setStatus(s, 'executing', s.brief.next_action || '正在执行', 'Agent 上报');
    }
    return true;
  }

  // Rebuild a brief from deterministic facts only (used by 刷新摘要; no model call in MVP).
  refreshBrief(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.type !== 'claude') { this._touch(s); return s; }
    if (s.brief && s.brief.source === 'agent_reported') {
      // Agent 上报优先级高于归纳,只更新时间戳观感,不覆盖内容
      this._event(s, 'brief', '刷新请求:保留 Agent 上报内容(优先级更高)');
      this._touch(s);
      return s;
    }
    const recent = s.events.slice(-6).map((e) => e.text);
    s.brief = {
      objective: s.command || '(未提供初始任务说明)',
      phase: s.status === 'verifying' ? 'verifying' : 'executing',
      progress: null,
      completed: [],
      blocker: null,
      decision: null,
      next_action: '进入终端查看详情',
      evidence: recent,
      source: 'observed',
      updated_at: new Date().toISOString(),
    };
    this._event(s, 'brief', '根据系统观测重建摘要');
    this._touch(s);
    return s;
  }

  flagBrief(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.briefFlagged = true;
    this._event(s, 'feedback', '用户标记:摘要不准确', '用户操作');
    this._touch(s);
  }

  setNote(id, note) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.note = String(note || '').slice(0, 500);
    this._event(s, 'note', '用户更新手工备注', '用户操作');
    this._touch(s);
  }

  // ---------- lifecycle actions ----------

  stop(id) {
    const s = this.sessions.get(id);
    const rt = this.runtime.get(id);
    if (!s) return;
    if (rt && s.alive) { try { rt.pty.kill(); } catch { } }
    this._event(s, 'lifecycle', '用户停止 session', '用户操作');
    this._touch(s);
  }

  restart(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    const rt = this.runtime.get(id);
    if (rt && s.alive) { try { rt.pty.kill(); } catch { } }
    const clients = rt ? rt.clients : new Set();
    setTimeout(() => {
      this._spawn(s);
      const nrt = this.runtime.get(id);
      for (const ws of clients) {
        nrt.clients.add(ws);
        if (!nrt.controller) nrt.controller = ws;
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', data: '\r\n\x1b[36m[已重启]\x1b[0m\r\n' }));
      }
      this._event(s, 'lifecycle', '用户重启 session', '用户操作');
      this._setStatus(s, s.type === 'claude' ? 'executing' : 'terminal_only', '已重启');
    }, 300);
  }

  rename(id, name) {
    const s = this.sessions.get(id);
    if (!s || !name) return;
    s.name = String(name).slice(0, 60);
    this._touch(s);
  }

  archive(id, archived = true) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.alive) this.stop(id);
    s.archived = archived;
    this._touch(s);
  }

  remove(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.alive) this.stop(id);
    if (s.worktree) {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', s.worktree], { cwd: s.projectDir });
        execFileSync('git', ['branch', '-D', s.branch], { cwd: s.projectDir });
      } catch { /* best effort */ }
    }
    this.sessions.delete(id);
    this.runtime.delete(id);
    this._save();
    this.onChange({ id, deleted: true });
  }

  _checkStale() {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (!s.alive || s.type !== 'claude') continue;
      if (!['executing', 'verifying'].includes(s.status)) continue;
      const last = s.lastOutputAt ? Date.parse(s.lastOutputAt) : Date.parse(s.createdAt);
      if (now - last > STALE_MS) {
        this._setStatus(s, 'stale', `已 ${Math.round((now - last) / 60000)} 分钟无输出,但进程未结束`);
      }
    }
  }
}

module.exports = { SessionManager, ATTENTION };
