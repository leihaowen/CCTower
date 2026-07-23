'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, execFile } = require('child_process');
const pty = require('node-pty');
const { Terminal: HeadlessTerminal } = require('@xterm/headless');
const { writeHookSettings, writeMcpConfig, protocolPrompt } = require('./claudeSetup');
const { computeDiff, squashMerge } = require('./gitReview');

const ATTENTION = new Set(['needs_decision', 'needs_permission', 'blocked', 'review_ready']);
const BUFFER_CAP = 200_000;
const STALE_MS = 10 * 60 * 1000;

class SessionManager {
  constructor({ dataDir, baseUrl, onChange, onNotify, backend, authToken }) {
    this.dataDir = dataDir;
    this.baseUrl = baseUrl;
    this.authToken = authToken || '';
    this.backend = backend || process.env.CCW_BACKEND || 'auto'; // 'auto'(优先 tmux)| 'pty'
    this.onChange = onChange; // (session) => void, broadcast state
    this.onNotify = onNotify; // (session, reason) => void, push notification
    this.sessions = new Map(); // id -> session (persisted shape)
    this.runtime = new Map(); // id -> { pty, buffer, clients:Set<ws>, controller:ws|null }
    this._merging = new Set(); // projectDir 级合并互斥
    fs.mkdirSync(path.join(dataDir, 'worktrees'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'hooks'), { recursive: true, mode: 0o700 });
    this.stateFile = path.join(dataDir, 'sessions.json');
    this._load();
    this._staleTimer = setInterval(() => this._checkStale(), 30_000);
  }

  _load() {
    try {
      const arr = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      for (const s of arr) {
        this.sessions.set(s.id, s);
        if (!s.alive) continue;
        // tmux 托管的会话在服务重启后仍在运行:重新接管而不是宣告死亡
        if (s.backend === 'tmux' && this._tmuxHas(s.id)) {
          try {
            this._wire(s, this._attachTmux(s));
            this._event(s, 'lifecycle', '服务重启,已重新接管仍在运行的会话(tmux)');
            continue;
          } catch { /* 接管失败按退出处理 */ }
        }
        s.alive = false;
        if (!['completed', 'exited'].includes(s.status)) {
          s.status = 'exited';
          s.statusLine = s.type === 'claude' && s.claudeSessionId
            ? '服务重启,原进程已结束;点「重启」将恢复原对话上下文'
            : '服务重启,原进程已结束;可点击「重启」继续';
        }
      }
    } catch { /* first boot */ }
  }

  _save() {
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => {
      const arr = [...this.sessions.values()];
      fs.writeFileSync(this.stateFile, JSON.stringify(arr, null, 2), { mode: 0o600 });
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
    // 连续重复事件折叠为一条(计数),防止周期性噪音刷满时间线
    const last = s.events[s.events.length - 1];
    if (last && last.kind === kind && last.text === text) {
      last.at = new Date().toISOString();
      last.count = (last.count || 1) + 1;
      return;
    }
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

  // ---------- 进程托管:tmux(默认,服务重启不丢会话)/ 直接 PTY(降级) ----------

  _cleanEnv() {
    // 剔除继承自启动环境的 Claude Code 标记,避免 session 内的 claude 被当作嵌套子会话(否则不保存 transcript)
    return Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE$|CLAUDE_CODE_)/.test(k))
    );
  }

  _tmux(args) {
    // 专用 socket + 空配置,与用户自己的 tmux 完全隔离
    return execFileSync('tmux', ['-L', 'ccw', '-f', '/dev/null', ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  _tmuxHas(id) {
    try { this._tmux(['has-session', '-t', `=ccw_${id}`]); return true; } catch { return false; }
  }

  _tmuxReady() {
    if (this.backend === 'pty') return false;
    if (this._tmuxOk !== undefined) return this._tmuxOk;
    try {
      execFileSync('tmux', ['-V'], { stdio: 'ignore' });
      this._tmuxOk = true;
    } catch {
      this._tmuxOk = false;
    }
    return this._tmuxOk;
  }

  // 全局参数在 new-session 之后应用:无会话时 tmux server 会自动退出(exit-empty),
  // 提前 start-server 再配置是竞态;每次应用,幂等且极廉价
  _applyTmuxGlobals() {
    const opts = [
      ['status', 'off'], ['history-limit', '8000'],
      ['set-titles', 'on'], ['set-titles-string', '#{pane_title}'],
      ['default-terminal', 'tmux-256color'], ['window-size', 'latest'],
      ['allow-passthrough', 'on'],
    ];
    try {
      for (const [k, v] of opts) this._tmux(['set-option', '-g', k, v]);
      this._tmux(['set-option', '-sg', 'escape-time', '0']);
    } catch { /* 配置失败不阻断会话 */ }
  }

  _buildCommand(s) {
    if (s.type === 'claude') {
      const hooksDir = path.join(this.dataDir, 'hooks');
      const hooksFile = writeHookSettings(hooksDir, this.baseUrl, s.id, this.authToken);
      const mcpFile = writeMcpConfig(hooksDir, this.baseUrl, s.id, this.authToken);
      const argv = ['claude', '--settings', hooksFile, '--mcp-config', mcpFile,
        '--append-system-prompt', protocolPrompt(this.baseUrl, s.id)];
      if (s.claudeSessionId) {
        // 重启走 resume:恢复原对话上下文,初始命令已在原对话里,不重发
        argv.push('--resume', s.claudeSessionId);
        this._event(s, 'lifecycle', `以 --resume 恢复原 Claude 对话(${s.claudeSessionId.slice(0, 8)}…)`);
      } else if (s.command) {
        argv.push(s.command);
      }
      return argv;
    }
    return [process.env.SHELL || 'bash'];
  }

  _attachTmux(s) {
    return pty.spawn('tmux', ['-L', 'ccw', '-f', '/dev/null', 'attach-session', '-t', `=ccw_${s.id}`], {
      name: 'xterm-256color', cols: 120, rows: 32,
      cwd: fs.existsSync(s.cwd) ? s.cwd : process.cwd(),
      env: this._cleanEnv(),
    });
  }

  _exitFile(id) { return path.join(this.dataDir, 'hooks', `exit-${id}`); }

  _spawn(s) {
    const argv = this._buildCommand(s);
    let p;
    if (this._tmuxReady()) {
      s.backend = 'tmux';
      const q = (a) => `'` + String(a).replace(/'/g, `'\\''`) + `'`;
      const launch = path.join(this.dataDir, 'hooks', `launch-${s.id}.sh`);
      fs.writeFileSync(launch, [
        '#!/usr/bin/env bash',
        // tmux server 继承了 CCTower 的环境,这里再剔除一次 Claude 标记
        `unset $(compgen -v | grep -E '^CLAUDECODE$|^CLAUDE_CODE_') 2>/dev/null || true`,
        `export CCW_SESSION_ID=${q(s.id)} CCW_BASE_URL=${q(this.baseUrl)}${this.authToken ? ` CCW_TOKEN=${q(this.authToken)}` : ''}`,
        `cd ${q(s.cwd)} || exit 97`,
        `rm -f ${q(this._exitFile(s.id))}`,
        argv.map(q).join(' '),
        'ec=$?',
        // attach 客户端拿不到程序退出码,落盘供 onExit 读取
        `echo "$ec" > ${q(this._exitFile(s.id))}`,
        'exit "$ec"',
      ].join('\n'), { mode: 0o700 }); // 含令牌导出,仅属主可读可执行
      try { this._tmux(['kill-session', '-t', `=ccw_${s.id}`]); } catch { /* 无残留 */ }
      this._tmux(['new-session', '-d', '-s', `ccw_${s.id}`, '-x', '120', '-y', '32', 'bash', launch]);
      this._applyTmuxGlobals();
      p = this._attachTmux(s);
    } else {
      s.backend = 'pty';
      const env = this._cleanEnv();
      env.CCW_SESSION_ID = s.id;
      env.CCW_BASE_URL = this.baseUrl;
      if (this.authToken) env.CCW_TOKEN = this.authToken;
      p = pty.spawn(argv[0], argv.slice(1), { name: 'xterm-256color', cols: 120, rows: 32, cwd: s.cwd, env });
    }
    this._wire(s, p, { usedResume: argv.includes('--resume') });
    if (s.type === 'terminal' && s.command) {
      setTimeout(() => { try { p.write(s.command + '\r'); } catch { } }, 300);
    }
  }

  // 挂接一个 PTY(新建或重新接管)到 session:屏幕状态、事件、退出处理
  _wire(s, p, { keepClients, usedResume } = {}) {
    // headless xterm 维护真实屏幕状态,供列表页迷你终端展示;列数必须与 PTY 一致,否则光标定位错乱
    const head = new HeadlessTerminal({ cols: 120, rows: 32, scrollback: 400, allowProposedApi: true });
    const rt = {
      pty: p, head, buffer: '', clients: keepClients || new Set(),
      controller: null, expectExit: false, booted: false, lastTail: '',
      usedResume: !!usedResume, spawnAt: Date.now(),
    };
    for (const ws of rt.clients) { if (!rt.controller && ws.readyState === 1) rt.controller = ws; }
    this.runtime.set(s.id, rt);
    // Claude Code 通过 OSC 0/2 持续上报会话主题(zellij 等复用器的标签名同源)
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
      // tmux 会话仍在而 attach 客户端意外断开:自动重新接管,不算退出
      if (s.backend === 'tmux' && !rt.expectExit && this.sessions.has(s.id) && this._tmuxHas(s.id)) {
        try {
          this._wire(s, this._attachTmux(s), { keepClients: rt.clients });
          this._event(s, 'lifecycle', 'attach 客户端断开,已自动重新接管 tmux 会话');
          this._touch(s);
          return;
        } catch { /* 接管失败按退出处理 */ }
      }
      let code = exitCode;
      if (s.backend === 'tmux') {
        // attach 客户端退出码不是程序退出码,读 launcher 落盘的真实值
        try { code = parseInt(fs.readFileSync(this._exitFile(s.id), 'utf8').trim(), 10); } catch { /* 保留 attach 码 */ }
        if (Number.isNaN(code)) code = exitCode;
      }
      s.alive = false;
      s.exitCode = code;
      for (const ws of rt.clients) {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'exit', code }));
      }
      if (!this.sessions.has(s.id)) return; // session 已删除,不再广播状态
      this._event(s, 'lifecycle', `进程退出,exit code ${code}`);
      if (rt.expectExit) {
        this._setStatus(s, 'exited', '已被用户停止');
      } else if (s.type === 'claude') {
        // --resume 后快速异常退出,多半是会话 id 失效(transcript 被清等):
        // 清掉 id,避免每次重启都陷入同一失败;下次重启开新对话
        if (code !== 0 && rt.usedResume && Date.now() - rt.spawnAt < 20_000 && s.claudeSessionId) {
          s.claudeSessionId = null;
          this._event(s, 'warning', 'resume 恢复失败(启动后即退出),已清除失效的会话 id;再次重启将开启新对话');
        }
        if (code === 0) this._setStatus(s, 'completed', 'Claude 会话已结束');
        else this._setStatus(s, 'blocked', `Claude 进程异常退出(code ${code})`);
      } else {
        this._setStatus(s, 'exited', `进程已退出(code ${code})`);
      }
    });
  }

  // 结束底层进程:tmux 托管杀 tmux 会话,直接 PTY 杀进程
  _killProc(s, rt) {
    rt.expectExit = true;
    if (s.backend === 'tmux') {
      try { this._tmux(['kill-session', '-t', `=ccw_${s.id}`]); return; } catch { /* 退回 pty kill */ }
    }
    try { rt.pty.kill(); } catch { /* 已死 */ }
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

  // 终端标题变化:Claude 会话且用户未手动命名时,自动跟随 Claude 的会话命名。
  // 标题会在工作/空闲形态间抖动,须稳定 10 秒才应用;同一名字只记一次事件。
  _onTitle(s, title) {
    const clean = String(title || '').replace(/^[\s✳✶✻·*∴◐◑◒◓-]+/, '').trim().slice(0, 60);
    if (!clean || clean === s.termTitle) return;
    s.termTitle = clean;
    const rt = this.runtime.get(s.id);
    if (!rt || s.type !== 'claude' || s.customNamed || /^claude$/i.test(clean)) return;
    clearTimeout(rt.titleT);
    rt.titleT = setTimeout(() => {
      if (s.termTitle !== clean || s.customNamed || s.name === clean) return;
      s.name = clean;
      rt.autoNamed = rt.autoNamed || [];
      if (!rt.autoNamed.includes(clean)) {
        rt.autoNamed = [clean, ...rt.autoNamed].slice(0, 3);
        this._event(s, 'lifecycle', `会话自动命名:${clean}(来自 Claude 标题上报)`);
      }
      this._touch(s);
    }, 10_000);
  }

  // 网页端批准/拒绝权限:向 TUI 权限对话框发送按键(1=允许第一项,Esc=拒绝)
  permissionAction(id, approve) {
    const s = this.sessions.get(id);
    const rt = this.runtime.get(id);
    if (!s || !rt || !s.alive || s.type !== 'claude') return false;
    const question = s.statusLine;
    try { rt.pty.write(approve ? '1' : '\x1b'); } catch { return false; }
    s.decisions.push({
      at: new Date().toISOString(), kind: 'permission',
      question, answer: approve ? '批准' : '拒绝', delivered: true,
    });
    s.lastSemanticAt = new Date().toISOString();
    s.lastNotified = null;
    this._event(s, 'input', approve ? '用户从网页批准权限请求' : '用户从网页拒绝权限请求', '用户操作');
    this._setStatus(s, 'executing', approve ? '权限已批准,继续执行' : '权限已拒绝,等待 Claude 调整方案', '用户操作');
    return true;
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
          const q = s.brief && s.brief.decision && s.brief.decision.question;
          if (q) {
            this._setStatus(s, 'needs_decision', `需要你决定:${q}`, 'Agent 上报');
          } else if (['executing', 'verifying', 'stale'].includes(s.status)) {
            this._setStatus(s, 'needs_decision', 'Claude 正在等待你的回答');
          }
          // ready(未领任务)与 review_ready/completed(任务已结束)的
          // 空闲提示只是"没人打字",不升级为需要决策
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
        // 回合结束且 agent 没有守约上报时,由 AI 归纳补一份摘要
        if (!this._agentBriefFresh(s)) this.aiBrief(id).catch(() => { });
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

  // 刷新摘要:优先 AI 归纳(claude -p);Agent 上报的新鲜摘要不被覆盖;失败退回系统观测重建
  refreshBrief(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.type !== 'claude') { this._touch(s); return s; }
    if (this._agentBriefFresh(s)) {
      this._event(s, 'brief', '刷新请求:保留 Agent 上报内容(优先级更高)');
      this._touch(s);
      return s;
    }
    this.aiBrief(id, { manual: true }).then((ok) => { if (!ok) this._observedBrief(s); });
    return s;
  }

  _agentBriefFresh(s) {
    return s.brief && s.brief.source === 'agent_reported'
      && Date.now() - Date.parse(s.brief.updated_at) < 5 * 60_000;
  }

  _observedBrief(s) {
    const recent = s.events.slice(-6).map((e) => e.text);
    s.brief = {
      objective: (s.brief && s.brief.objective) || s.command || '(未提供初始任务说明)',
      phase: s.status === 'verifying' ? 'verifying' : 'executing',
      progress: null, completed: [], blocker: null, decision: null,
      next_action: '进入终端查看详情',
      evidence: recent,
      source: 'observed',
      updated_at: new Date().toISOString(),
    };
    this._event(s, 'brief', '根据系统观测重建摘要');
    this._touch(s);
  }

  // AI 归纳(PRD 状态来源第三层):headless claude -p 读取近期事件与屏幕尾部,产出结构化 Brief。
  // 只在回合结束或手动刷新时调用,全局串行,60 秒节流,不覆盖新鲜的 Agent 上报。
  async aiBrief(id, { manual = false } = {}) {
    const s = this.sessions.get(id);
    if (!s || s.type !== 'claude') return false;
    const rt = this.runtime.get(id);
    const now = Date.now();
    if (!manual && rt && rt.aiBriefAt && now - rt.aiBriefAt < 60_000) return false;
    if (this._agentBriefFresh(s)) return false;
    if (this._aiBusy) return false;
    this._aiBusy = true;
    if (rt) rt.aiBriefAt = now;
    this._event(s, 'brief', '正在调用模型生成 AI 归纳摘要…', 'AI 归纳');
    this._touch(s);
    try {
      const material = {
        任务初始说明: s.command || '(无)',
        当前状态: `${s.status} — ${s.statusLine}`,
        近期事件: s.events.slice(-15).map((e) => `${e.at.slice(11, 19)} [${e.kind}] ${e.text}`),
        终端画面尾部: String(s.tailCache || '').slice(-1500),
        近期决策: s.decisions.slice(-3),
      };
      const prompt = [
        '你是 CCTower 的会话摘要引擎。根据以下某个 Claude Code 会话的观测材料,生成一份结构化工作摘要。',
        '只输出一个 JSON 对象,不要任何其他文字。字段:',
        '{"objective": "用户目标(一句)", "phase": "executing|verifying|waiting|review", "progress": {"done": 整数, "total": 整数} 或 null, "completed": ["已完成事项,最多4条"], "blocker": "阻塞原因或 null", "decision": null, "next_action": "建议下一步(可执行的一句)", "evidence": ["依据,最多3条"]}',
        '规则:只陈述材料中有依据的内容,不要编造进度;不确定就用 null;中文;每条不超过40字。',
        '材料:',
        JSON.stringify(material, null, 1),
      ].join('\n');
      const stdout = await new Promise((resolve, reject) => {
        execFile('claude', ['-p', prompt, '--output-format', 'json'], {
          env: this._cleanEnv(), cwd: os.tmpdir(), timeout: 90_000, maxBuffer: 4_000_000,
        }, (err, out) => (err ? reject(err) : resolve(out)));
      });
      const text = String(JSON.parse(stdout).result || '');
      const b = JSON.parse((text.match(/\{[\s\S]*\}/) || ['{}'])[0]);
      if (!b.objective && !b.next_action) throw new Error('模型未返回有效摘要');
      s.brief = {
        objective: b.objective || s.command || '',
        phase: ['executing', 'verifying', 'waiting', 'review'].includes(b.phase) ? b.phase : 'executing',
        progress: b.progress && Number.isFinite(b.progress.total) ? b.progress : null,
        completed: Array.isArray(b.completed) ? b.completed.slice(0, 4) : [],
        blocker: b.blocker || null,
        decision: null, // AI 不代替 agent 提决策问题
        next_action: b.next_action || '',
        evidence: Array.isArray(b.evidence) ? b.evidence.slice(0, 3) : [],
        source: 'ai_inferred',
        updated_at: new Date().toISOString(),
      };
      s.briefFlagged = false;
      this._event(s, 'brief', 'AI 归纳摘要已更新', 'AI 归纳');
      this._touch(s);
      return true;
    } catch (e) {
      this._event(s, 'warning', `AI 归纳失败(${String(e.message).split('\n')[0].slice(0, 80)})`, 'AI 归纳');
      this._touch(s);
      return false;
    } finally {
      this._aiBusy = false;
    }
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
    if (rt && s.alive) this._killProc(s, rt);
    this._event(s, 'lifecycle', '用户停止 session', '用户操作');
    this._touch(s);
  }

  restart(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    const rt = this.runtime.get(id);
    if (rt && s.alive) this._killProc(s, rt);
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

  _cleanupWorktree(s) {
    if (!s.worktree) return;
    try {
      execFileSync('git', ['worktree', 'remove', '--force', s.worktree], { cwd: s.projectDir });
      execFileSync('git', ['branch', '-D', s.branch], { cwd: s.projectDir });
      this._event(s, 'lifecycle', `已清理 worktree 与分支 ${s.branch}`, '用户操作');
      s.worktree = null;
      s.branch = null;
    } catch (e) {
      this._event(s, 'warning', `清理 worktree 失败:${String(e.message).split('\n')[0].slice(0, 80)}`);
    }
  }

  // 合并后收尾一条龙:停止进程、清理 worktree 与分支、归档;保留会话记录与时间线
  finish(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.alive) this.stop(id);
    setTimeout(() => {
      this._cleanupWorktree(s);
      s.archived = true;
      this._event(s, 'lifecycle', '合并完成,session 已归档收尾', '用户操作');
      this._touch(s);
    }, 500);
    return true;
  }

  remove(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.alive) this.stop(id);
    // alive 标记可能因接管失败而失真,tmux 会话残留一律清理
    if (s.backend === 'tmux') { try { this._tmux(['kill-session', '-t', `=ccw_${id}`]); } catch { /* 无残留 */ } }
    try { fs.rmSync(this._exitFile(id), { force: true }); } catch { }
    try { fs.rmSync(path.join(this.dataDir, 'hooks', `launch-${id}.sh`), { force: true }); } catch { }
    this._cleanupWorktree(s);
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
      const { plain, html } = this._tailOf(rt);
      if (plain !== rt.lastTail) {
        rt.lastTail = plain;
        s.tailCache = plain; // 纯文本:AI 归纳材料 + 变化比对
        s.tailHtml = html; // 着色 HTML:迷你终端展示(服务端已转义)
        out.push({ id, tail: plain, html });
      }
    }
    if (out.length) this._save();
    return out;
  }

  _escHtml(t) { return String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  _tailOf(rt) {
    // 纯边框/分隔线行(TUI 包装盒)对窄卡片是噪音,整行剔除
    const BOX_ONLY = /^[\s─━═╌╍┄┅┈┉╭╮╰╯┌┐└┘├┤┬┴┼│┃║▔▁▏▕\-_=~·.]*$/;
    try {
      const buf = rt.head.buffer.active;
      const total = buf.length;
      const cleaned = []; // { plain, segs: [{ text, cls, rgb }] }
      for (let i = Math.max(0, total - 60); i < total; i++) {
        const line = buf.getLine(i);
        if (!line) continue;
        // 逐格提取文本与前景色,合并同色连续段
        const segs = [];
        for (let x = 0; x < line.length; x++) {
          const cell = line.getCell(x);
          if (!cell) break;
          const ch = cell.getChars() || (cell.getWidth() ? ' ' : '');
          if (!ch) continue;
          let cls = '', rgb = '';
          if (cell.isFgPalette()) {
            const n = cell.getFgColor();
            if (n >= 0 && n < 16) cls = `tc-${n}`;
          } else if (cell.isFgRGB()) {
            const v = cell.getFgColor();
            rgb = `${(v >> 16) & 255},${(v >> 8) & 255},${v & 255}`;
          }
          if (cell.isBold()) cls = (cls ? cls + ' ' : '') + 'tb';
          const last = segs[segs.length - 1];
          if (last && last.cls === cls && last.rgb === rgb) last.text += ch;
          else segs.push({ text: ch, cls, rgb });
        }
        // 行级清洗在纯文本上决策(去包边、折叠长横线/大段空白),再同步裁剪段
        for (const g of segs) g.text = g.text.replace(/[─━═]{3,}/g, ' ').replace(/ {4,}/g, '   ');
        let plain = segs.map((g) => g.text).join('').trimEnd();
        const lead = (plain.match(/^[│┃║]\s?/) || [''])[0].length;
        plain = plain.slice(lead).replace(/\s?[│┃║]\s*$/, '').trimEnd();
        if (BOX_ONLY.test(plain)) plain = '';
        // 连续空行折叠为一行
        if (!plain && (!cleaned.length || !cleaned[cleaned.length - 1].plain)) continue;
        let toDrop = lead;
        let budget = plain.length;
        const kept = [];
        for (const g of segs) {
          let t = g.text;
          if (toDrop > 0) { const d = Math.min(toDrop, t.length); t = t.slice(d); toDrop -= d; }
          if (!t || budget <= 0) continue;
          if (t.length > budget) t = t.slice(0, budget);
          budget -= t.length;
          kept.push({ text: t, cls: g.cls, rgb: g.rgb });
        }
        cleaned.push({ plain, segs: plain ? kept : [] });
      }
      while (cleaned.length && !cleaned[cleaned.length - 1].plain) cleaned.pop();
      const lines = cleaned.slice(-14);
      return {
        plain: lines.map((l) => l.plain).join('\n'),
        html: lines.map((l) => l.segs.map((g) => {
          const t = this._escHtml(g.text);
          if (!g.cls && !g.rgb) return t;
          return `<span${g.cls ? ` class="${g.cls}"` : ''}${g.rgb ? ` style="color:rgb(${g.rgb})"` : ''}>${t}</span>`;
        }).join('')).join('\n'),
      };
    } catch {
      return { plain: rt.lastTail || '', html: this._escHtml(rt.lastTail || '') };
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
