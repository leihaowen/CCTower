'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const pty = require('node-pty');
const { Terminal: HeadlessTerminal } = require('@xterm/headless');
const { writeHookSettings, protocolPrompt } = require('./claudeSetup');
const { computeDiff, squashMerge } = require('./gitReview');

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
    this._merging = new Set(); // projectDir 级合并互斥
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
            s.statusLine = s.type === 'claude' && s.claudeSessionId
              ? '服务重启,原进程已结束;点「重启」将恢复原对话上下文'
              : '服务重启,原进程已结束;可点击「重启」继续';
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
    if (s.status !== status) s.statusChangedAt = new Date().toISOString();
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
      customNamed: !!name, // 用户起过名则不被自动命名覆盖
      termTitle: '',
      type, // 'terminal' | 'claude'
      projectDir,
      cwd: projectDir,
      command: command || '',
      isolate: type === 'claude' ? isolate !== false : false,
      claudeSessionId: null, // Claude Code 内部会话 id,来自 hook payload;重启时用于 --resume
      worktree: null,
      branch: null,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      lastOutputAt: null,
      lastSemanticAt: new Date().toISOString(), // 最后一次 hook/上报/用户输入,用于 stale 判定
      status: type === 'claude' ? 'ready' : 'terminal_only',
      statusChangedAt: new Date().toISOString(),
      statusLine: type === 'claude' ? '正在启动 Claude Code…' : '普通终端,语义未知',
      tailCache: '',
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
    // 剔除继承自启动环境的 Claude Code 标记,避免 session 内的 claude 被当作嵌套子会话(否则不保存 transcript)
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE$|CLAUDE_CODE_)/.test(k))
    );
    env.CCW_SESSION_ID = s.id;
    env.CCW_BASE_URL = this.baseUrl;
    if (s.type === 'claude') {
      const hooksFile = writeHookSettings(path.join(this.dataDir, 'hooks'), this.baseUrl, s.id);
      file = 'claude';
      args = ['--settings', hooksFile, '--append-system-prompt', protocolPrompt(this.baseUrl, s.id)];
      if (s.claudeSessionId) {
        // 重启走 resume:恢复原对话上下文,初始命令已在原对话里,不重发
        args.push('--resume', s.claudeSessionId);
        this._event(s, 'lifecycle', `以 --resume 恢复原 Claude 对话(${s.claudeSessionId.slice(0, 8)}…)`);
      } else if (s.command) {
        args.push(s.command);
      }
    } else {
      file = process.env.SHELL || 'bash';
      args = [];
    }
    const p = pty.spawn(file, args, {
      name: 'xterm-256color', cols: 120, rows: 32, cwd: s.cwd, env,
    });
    // headless xterm 维护真实屏幕状态,供列表页迷你终端展示;列数必须与 PTY 一致,否则光标定位错乱
    const head = new HeadlessTerminal({ cols: 120, rows: 32, scrollback: 400, allowProposedApi: true });
    const rt = { pty: p, head, buffer: '', clients: new Set(), controller: null, expectExit: false, booted: false, lastTail: '' };
    this.runtime.set(s.id, rt);
    // Claude Code 通过 OSC 0/2 持续上报会话主题(zellij 等复用器的标签名同源);
    // headless xterm 负责解析,含跨 chunk 拼接
    head.onTitleChange((title) => this._onTitle(s, title));
    s.alive = true;
    s.exitCode = null;

    p.onData((data) => {
      rt.buffer = (rt.buffer + data).slice(-BUFFER_CAP);
      try { rt.head.write(data); } catch { /* 极端序列解析失败不影响主流程 */ }
      s.lastOutputAt = new Date().toISOString();
      if (!rt.booted) {
        rt.booted = true;
        if (s.type === 'claude' && s.status === 'ready') {
          this._setStatus(s, 'ready', s.command ? '已启动,正在提交初始任务' : '已就绪,等待任务');
        }
      }
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
      for (const ws of rt.clients) {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
      }
      if (!this.sessions.has(s.id)) return; // session 已删除,不再广播状态
      this._event(s, 'lifecycle', `进程退出,exit code ${exitCode}`);
      if (rt.expectExit) {
        this._setStatus(s, 'exited', '已被用户停止');
      } else if (s.type === 'claude') {
        if (exitCode === 0) this._setStatus(s, 'completed', 'Claude 会话已结束');
        else this._setStatus(s, 'blocked', `Claude 进程异常退出(code ${exitCode})`);
      } else {
        this._setStatus(s, 'exited', `进程已退出(code ${exitCode})`);
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
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    if (!rt.controller || rt.controller.readyState !== 1) rt.controller = ws;
    ws.send(JSON.stringify({ type: 'data', data: rt.buffer }));
    ws.send(JSON.stringify({ type: 'role', controller: rt.controller === ws }));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'input') {
        if (rt.controller === ws && s.alive) {
          rt.pty.write(m.data);
          // 只记录"发生过交互"用于 stale 判定,不记录击键内容(可能含敏感信息)
          if (m.data.includes('\r') || m.data.includes('\n')) s.lastSemanticAt = new Date().toISOString();
        }
      } else if (m.type === 'resize') {
        if (rt.controller === ws && s.alive) {
          try { rt.pty.resize(m.cols, m.rows); } catch { }
          try { rt.head.resize(m.cols, m.rows); } catch { } // 与 PTY 保持同尺寸
        }
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
    s.lastSemanticAt = new Date().toISOString();
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

  // 终端标题变化:记录;Claude 会话且用户未手动命名时,自动跟随 Claude 的会话命名
  _onTitle(s, title) {
    const clean = String(title || '').replace(/^[\s✳✶✻·*∴◐◑◒◓-]+/, '').trim().slice(0, 60);
    if (!clean || clean === s.termTitle) return;
    s.termTitle = clean;
    if (s.type === 'claude' && !s.customNamed && !/^claude$/i.test(clean)) {
      if (s.name !== clean) {
        this._event(s, 'lifecycle', `会话自动命名:${clean}(来自 Claude 标题上报)`);
        s.name = clean;
      }
    }
    this._touch(s);
  }

  // ---------- claude signals ----------

  applyHook(id, event, payload) {
    const s = this.sessions.get(id);
    if (!s || s.type !== 'claude') return;
    const msg = (payload && (payload.message || payload.title)) || '';
    // hook payload 自带 Claude 内部 session_id;resume 后会换新 id,始终跟随最新值
    if (payload && payload.session_id && s.claudeSessionId !== payload.session_id) {
      s.claudeSessionId = payload.session_id;
    }
    s.lastSemanticAt = new Date().toISOString();
    this._event(s, 'hook', `${event}${msg ? ':' + msg : ''}`);
    switch (event) {
      case 'Notification': {
        const low = msg.toLowerCase();
        if (low.includes('permission') || msg.includes('权限')) {
          this._setStatus(s, 'needs_permission', msg || 'Claude 请求批准一项敏感操作');
        } else if (low.includes('waiting') || msg.includes('等待')) {
          // 尚未领到任务的空闲提示不算"等你决策"
          if (s.status !== 'ready') {
            const q = s.brief && s.brief.decision && s.brief.decision.question;
            this._setStatus(s, 'needs_decision', q ? `需要你决定:${q}` : 'Claude 正在等待你的回答', q ? 'Agent 上报' : '系统观测');
          }
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
    s.lastSemanticAt = new Date().toISOString();
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
      // 上报发生在回合中途,agent 往往还在继续输出;先不置黄灯不通知,
      // 待 Stop hook 确认它真正停下等输入后再切 needs_decision(见 applyHook)
      if (s.status === 'needs_decision') {
        this._setStatus(s, 'needs_decision', `需要你决定:${s.brief.decision.question}`, 'Agent 上报');
      } else {
        this._setStatus(s, 'executing', `即将需要你决定:${s.brief.decision.question}`, 'Agent 上报');
      }
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

  // ---------- diff 审阅与合并 ----------

  _reviewable(id) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('session 不存在');
    if (!s.worktree) throw new Error('该 session 没有独立 worktree,无法审阅/合并');
    if (!fs.existsSync(s.worktree)) throw new Error('worktree 目录已不存在');
    return s;
  }

  diff(id) {
    const s = this._reviewable(id);
    return computeDiff({ projectDir: s.projectDir, worktree: s.worktree, branch: s.branch });
  }

  merge(id) {
    const s = this._reviewable(id);
    if (this._merging.has(s.projectDir)) throw new Error('该项目另一个合并正在进行,请稍后再试');
    this._merging.add(s.projectDir);
    try {
      const objective = (s.brief && s.brief.objective) || s.command || '(无任务说明)';
      const message = `ccw: ${s.name}\n\n任务:${objective}\nsession:${s.id}\n来源分支:${s.branch}`;
      const r = squashMerge({ projectDir: s.projectDir, worktree: s.worktree, branch: s.branch, message });
      if (r.merged) {
        this._event(s, 'lifecycle', `已 squash 合并到 ${r.target}(${r.hash})`, '用户操作');
        s.decisions.push({ at: new Date().toISOString(), question: `合并到 ${r.target}?`, answer: `已合并(${r.hash})`, delivered: true });
      } else {
        this._event(s, 'warning', `合并被冲突预检拦下:${r.files.join('、')};${r.target} 未被改动`, '用户操作');
      }
      this._touch(s);
      return r;
    } catch (e) {
      this._event(s, 'warning', `合并失败:${e.message}`);
      this._touch(s);
      throw e;
    } finally {
      this._merging.delete(s.projectDir);
    }
  }

  resolveConflict(id, { target, files } = {}) {
    this._reviewable(id);
    const list = Array.isArray(files) && files.length ? files.join('、') : '(见 git 输出)';
    const text = `请在当前 worktree 中执行 git merge ${target || '主分支'},解决以下文件的冲突并在验证通过后 commit,完成后上报 review:${list}`;
    const ok = this.sendInput(id, text, { record: { question: '合并有冲突,需要在 worktree 内解决' } });
    if (!ok) throw new Error('session 未在运行,无法发送解决冲突指令');
    return { delivered: true };
  }

  // ---------- lifecycle actions ----------

  stop(id) {
    const s = this.sessions.get(id);
    const rt = this.runtime.get(id);
    if (!s) return;
    if (rt && s.alive) { rt.expectExit = true; try { rt.pty.kill(); } catch { } }
    this._event(s, 'lifecycle', '用户停止 session', '用户操作');
    this._touch(s);
  }

  restart(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    const rt = this.runtime.get(id);
    if (rt && s.alive) { rt.expectExit = true; try { rt.pty.kill(); } catch { } }
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
      this._setStatus(s, s.type === 'claude' ? 'ready' : 'terminal_only', '已重启');
    }, 300);
  }

  rename(id, name) {
    const s = this.sessions.get(id);
    if (!s || !name) return;
    s.name = String(name).slice(0, 60);
    s.customNamed = true; // 手动命名后不再被自动命名覆盖
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
      // TUI 空闲时也会周期性重绘,不能以原始输出判定;以最后一次 hook/上报/用户输入为准
      const last = Date.parse(s.lastSemanticAt || s.createdAt);
      if (now - last > STALE_MS) {
        this._setStatus(s, 'stale', `已 ${Math.round((now - last) / 60000)} 分钟无实质进展(hook/上报),但进程未结束`);
      }
    }
  }

  // ---------- 迷你终端画面 ----------

  // 返回自上次调用以来画面有变化的 session 的最新屏幕文本
  collectTails() {
    const out = [];
    for (const [id, rt] of this.runtime) {
      const s = this.sessions.get(id);
      if (!s || !s.alive) continue;
      const tail = this._tailOf(rt);
      if (tail !== rt.lastTail) {
        rt.lastTail = tail;
        s.tailCache = tail;
        out.push({ id, tail });
      }
    }
    if (out.length) this._save();
    return out;
  }

  _tailOf(rt) {
    // 纯边框/分隔线行(TUI 包装盒)对窄卡片是噪音,整行剔除
    const BOX_ONLY = /^[\s─━═╌╍┄┅┈┉╭╮╰╯┌┐└┘├┤┬┴┼│┃║▔▁▏▕\-_=~·.]*$/;
    try {
      const buf = rt.head.buffer.active;
      const total = buf.length;
      const cleaned = [];
      for (let i = Math.max(0, total - 60); i < total; i++) {
        const line = buf.getLine(i);
        let t = line ? line.translateToString(true) : '';
        t = t.replace(/^[│┃║]\s?/, '').replace(/\s?[│┃║]\s*$/, ''); // 去左右包边
        t = t.replace(/[─━═]{3,}/g, ' ').replace(/ {4,}/g, '   ').trimEnd();
        if (BOX_ONLY.test(t)) t = '';
        // 连续空行折叠为一行
        if (!t && (!cleaned.length || !cleaned[cleaned.length - 1])) continue;
        cleaned.push(t);
      }
      while (cleaned.length && !cleaned[cleaned.length - 1]) cleaned.pop();
      return cleaned.slice(-14).join('\n');
    } catch {
      return rt.lastTail;
    }
  }

  // 强制重绘:轻微抖动 PTY 尺寸触发 SIGWINCH,让 TUI 全量重画
  redraw(id) {
    const s = this.sessions.get(id);
    const rt = this.runtime.get(id);
    if (!s || !rt || !s.alive) return false;
    const { cols, rows } = rt.pty;
    try {
      rt.pty.resize(cols + 1, rows);
      rt.head.resize(cols + 1, rows);
      setTimeout(() => {
        try { rt.pty.resize(cols, rows); rt.head.resize(cols, rows); } catch { }
      }, 80);
    } catch { return false; }
    return true;
  }

  // 心跳:上一轮没回 pong 的连接视为死连接,主动 terminate。
  // 关键作用:清掉标签页休眠留下的半开连接,否则它会一直占着
  // "输入控制者"身份,重连回来的标签页只能只读、resize 被忽略,
  // 导致 TUI 底部(输入框/状态栏)被裁掉。
  pingClients() {
    for (const rt of this.runtime.values()) {
      for (const ws of rt.clients) {
        if (ws.isAlive === false) { try { ws.terminate(); } catch { } continue; }
        ws.isAlive = false;
        if (ws.readyState === 1) { try { ws.ping(); } catch { } }
      }
    }
  }
}

module.exports = { SessionManager, ATTENTION };
