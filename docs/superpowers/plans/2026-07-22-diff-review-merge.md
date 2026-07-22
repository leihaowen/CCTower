# Diff 审阅 + 一键合并 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在网页审阅 worktree session 的全部改动(含未提交与新文件),一键 squash 合并回主分支;冲突被无副作用预检拦下并可一键交给 Claude 解决。

**Architecture:** git 逻辑收进新模块 `server/gitReview.js`(两个无状态函数 `computeDiff` / `squashMerge`,内部全部 `execFileSync` 调 git);`manager.js` 只做 session 校验、互斥锁、事件记录;`index.js` 加一个 GET 路由和两个 action;前端在 `app.js` 加全屏审阅覆盖层与自绘 unified diff 渲染器。

**Tech Stack:** Node 24(内建 test runner `node --test`)、git ≥ 2.38(`merge-tree --write-tree`,本机 2.39.5)、原生 JS 前端(无构建)。

**规格:** `docs/superpowers/specs/2026-07-22-diff-review-merge-design.md`(所有产品决策以它为准)

## Global Constraints

- 零新依赖:不新增任何 npm 包、不引入前端库。
- 所有用户可见文案为中文,风格与现有代码一致(逗号用全角,冒号用全角)。
- 合并失败/冲突时目标分支必须分毫不动;预检用 `git merge-tree --write-tree`(纯 plumbing)。
- 仅 `s.worktree` 非空的 session 可用;其他一律 400。
- diff 文本超过 1MB 截断并置 `truncated: true`,`files` 列表始终完整。
- 前端资源修改后把 `public/index.html` 里的 `?v=7` 升到 `?v=8`(两处)。
- git 调用统一 `execFileSync`(数组传参,不走 shell),与现有 `manager.js` 一致。

---

### Task 1: `gitReview.computeDiff` — 读取 session 全部改动

**Files:**
- Create: `server/gitReview.js`
- Create: `server/gitReview.test.js`

**Interfaces:**
- Produces: `computeDiff({ projectDir, worktree, branch })` → `{ target, branch, behind, files: [{path, add, del}], diff, truncated }`。`add`/`del` 为数字,二进制文件为 `null`。目标分支 detached / 无共同祖先时 `throw new Error(中文提示)`。
- Produces(内部,Task 2 复用): `git(args, cwd)`(封装 execFileSync)、`gitLoose(args, cwd)` → `{ status, stdout }`(容忍非零退出)、`targetBranchOf(projectDir)`。

- [ ] **Step 1: 写失败的测试**

创建 `server/gitReview.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { computeDiff } = require('./gitReview');

function run(args, cwd) { return execFileSync('git', args, { cwd, encoding: 'utf8' }); }
function write(dir, f, content) {
  fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
  fs.writeFileSync(path.join(dir, f), content);
}
function commitAll(dir, msg) { run(['add', '-A'], dir); run(['commit', '-m', msg], dir); }

// 真实 git 仓库 + 真实 worktree,与生产结构一致(worktree 在 projectDir 之外)
function makeFixture() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-proj-'));
  run(['init', '-b', 'main'], projectDir);
  run(['config', 'user.email', 'test@ccw'], projectDir);
  run(['config', 'user.name', 'ccw-test'], projectDir);
  write(projectDir, 'a.txt', 'line1\nline2\n');
  commitAll(projectDir, 'init');
  const worktree = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-wt-')), 's1');
  run(['worktree', 'add', worktree, '-b', 'ccw/s1'], projectDir);
  return { projectDir, worktree, branch: 'ccw/s1' };
}

test('computeDiff:包含已提交、未提交与未跟踪改动', () => {
  const fx = makeFixture();
  write(fx.worktree, 'a.txt', 'line1\nline2\nline3\n');
  commitAll(fx.worktree, 'add line3');
  write(fx.worktree, 'a.txt', 'line1\nline2\nline3\nline4\n'); // 已跟踪、未提交
  write(fx.worktree, 'sub/new.txt', 'hello\n');                // 未跟踪(且在子目录)
  const d = computeDiff(fx);
  assert.equal(d.target, 'main');
  assert.equal(d.branch, 'ccw/s1');
  assert.equal(d.behind, 0);
  assert.ok(d.diff.includes('+line3'));
  assert.ok(d.diff.includes('+line4'));
  assert.ok(d.diff.includes('+hello'));
  const paths = d.files.map((f) => f.path);
  assert.ok(paths.includes('a.txt'));
  assert.ok(paths.includes('sub/new.txt'));
  const nf = d.files.find((f) => f.path === 'sub/new.txt');
  assert.equal(nf.add, 1);
  assert.equal(nf.del, 0);
  assert.equal(d.truncated, false);
});

test('computeDiff:main 前进的提交不掺入 diff,behind 计数正确', () => {
  const fx = makeFixture();
  write(fx.projectDir, 'b.txt', 'main-only\n');
  commitAll(fx.projectDir, 'main forward');
  write(fx.worktree, 'a.txt', 'line1\nline2\nchanged\n');
  const d = computeDiff(fx);
  assert.equal(d.behind, 1);
  assert.ok(!d.diff.includes('main-only'));
  assert.ok(d.diff.includes('+changed'));
});

test('computeDiff:超大 diff 截断且 files 完整', () => {
  const fx = makeFixture();
  const big = Array.from({ length: 2400 }, (_, i) => 'x'.repeat(500) + i).join('\n') + '\n';
  write(fx.worktree, 'big.txt', big); // 未跟踪,diff 约 1.2MB
  const d = computeDiff(fx);
  assert.equal(d.truncated, true);
  assert.ok(d.files.some((f) => f.path === 'big.txt'));
});

test('computeDiff:projectDir detached HEAD 报错', () => {
  const fx = makeFixture();
  run(['checkout', '--detach'], fx.projectDir);
  assert.throws(() => computeDiff(fx), /detached HEAD/);
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `node --test server/gitReview.test.js`
Expected: 全部 FAIL,报 `Cannot find module './gitReview'`

- [ ] **Step 3: 实现 `computeDiff`**

创建 `server/gitReview.js`:

```js
'use strict';
const { execFileSync } = require('child_process');

const DIFF_CAP = 1024 * 1024; // 超过 1MB 截断,files 列表不受影响

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// git 会以非零退出但仍产出有效 stdout 的调用(diff --no-index、merge-tree)
function gitLoose(args, cwd) {
  try { return { status: 0, stdout: git(args, cwd) }; }
  catch (e) {
    if (typeof e.status === 'number' && e.stdout != null) return { status: e.status, stdout: String(e.stdout) };
    throw e;
  }
}

// 合并目标 = projectDir 当前 checkout 的分支,不硬编码 main
function targetBranchOf(projectDir) {
  try { return git(['symbolic-ref', '--short', 'HEAD'], projectDir).trim(); }
  catch { throw new Error('项目目录处于 detached HEAD,请先 checkout 到分支再操作'); }
}

function computeDiff({ projectDir, worktree, branch }) {
  const target = targetBranchOf(projectDir);
  let base;
  try { base = git(['merge-base', target, 'HEAD'], worktree).trim(); }
  catch { throw new Error(`分支 ${branch} 与 ${target} 没有共同祖先,无法对比`); }
  const behind = Number(git(['rev-list', '--count', `HEAD..${target}`], worktree).trim()) || 0;

  // 已跟踪改动(已提交 + 未提交):从 merge-base 直接对比到工作区
  const files = [];
  for (const line of git(['diff', '--numstat', base], worktree).split('\n')) {
    if (!line.trim()) continue;
    const [add, del, ...rest] = line.split('\t');
    files.push({
      path: rest.join('\t'),
      add: add === '-' ? null : Number(add),
      del: del === '-' ? null : Number(del),
    });
  }
  let diff = git(['diff', base], worktree);

  // 未跟踪的新文件:逐个以 --no-index 拼入,不动 worktree 的 index
  const untracked = git(['status', '--porcelain', '-uall'], worktree).split('\n')
    .filter((l) => l.startsWith('?? ')).map((l) => l.slice(3).trim());
  for (const f of untracked) {
    const r = gitLoose(['diff', '--no-index', '--', '/dev/null', f], worktree);
    if (r.status > 1) continue; // 意外错误(如文件消失),跳过该文件
    diff += r.stdout;
    const binary = /^Binary files /m.test(r.stdout);
    const add = binary ? null : (r.stdout.match(/^\+(?!\+\+)/gm) || []).length;
    files.push({ path: f, add, del: binary ? null : 0 });
  }

  let truncated = false;
  if (diff.length > DIFF_CAP) { diff = diff.slice(0, DIFF_CAP); truncated = true; }
  return { target, branch, behind, files, diff, truncated };
}

module.exports = { computeDiff, git, gitLoose, targetBranchOf };
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `node --test server/gitReview.test.js`
Expected: 4 个测试全部 PASS

- [ ] **Step 5: 提交**

```bash
git add server/gitReview.js server/gitReview.test.js
git commit -m "gitReview.computeDiff:读取 worktree 全部改动(含未提交与未跟踪)"
```

---

### Task 2: `gitReview.squashMerge` — 预检 + squash 合并

**Files:**
- Modify: `server/gitReview.js`(文件末尾 `module.exports` 前追加)
- Modify: `server/gitReview.test.js`(追加测试)

**Interfaces:**
- Consumes: Task 1 的 `git` / `gitLoose` / `targetBranchOf`。
- Produces: `squashMerge({ projectDir, worktree, branch, message })` →
  成功 `{ merged: true, target, hash }`;冲突 `{ merged: false, conflict: true, target, files: [...] }`;
  其余情形 `throw new Error(中文提示)`(detached HEAD、projectDir 脏、无共同祖先、执行失败)。

- [ ] **Step 1: 追加失败的测试**

在 `server/gitReview.test.js` 顶部 require 行改为:

```js
const { computeDiff, squashMerge } = require('./gitReview');
```

文件末尾追加:

```js
test('squashMerge:干净合并,main 恰好多一条 squash 提交', () => {
  const fx = makeFixture();
  write(fx.worktree, 'a.txt', 'line1\nline2\nline3\n');
  commitAll(fx.worktree, 'c1');
  write(fx.worktree, 'a.txt', 'line1\nline2\nline3\nline4\n');
  commitAll(fx.worktree, 'c2');
  const before = Number(run(['rev-list', '--count', 'main'], fx.projectDir).trim());
  const r = squashMerge({ ...fx, message: 'ccw: 测试合并\n\n任务:验收' });
  assert.equal(r.merged, true);
  assert.equal(r.target, 'main');
  assert.ok(r.hash);
  assert.equal(Number(run(['rev-list', '--count', 'main'], fx.projectDir).trim()), before + 1);
  assert.ok(fs.readFileSync(path.join(fx.projectDir, 'a.txt'), 'utf8').includes('line4'));
  assert.equal(run(['status', '--porcelain'], fx.projectDir).trim(), '');
  assert.ok(run(['log', '-1', '--format=%s'], fx.projectDir).includes('ccw: 测试合并'));
});

test('squashMerge:worktree 未提交改动自动收拢进合并', () => {
  const fx = makeFixture();
  write(fx.worktree, 'new.txt', 'dirty\n'); // 未提交也未跟踪
  const r = squashMerge({ ...fx, message: 'm' });
  assert.equal(r.merged, true);
  assert.equal(fs.readFileSync(path.join(fx.projectDir, 'new.txt'), 'utf8'), 'dirty\n');
});

test('squashMerge:冲突被预检拦下,main 无任何改动', () => {
  const fx = makeFixture();
  write(fx.worktree, 'a.txt', 'branch-version\n');
  commitAll(fx.worktree, 'branch change');
  write(fx.projectDir, 'a.txt', 'main-version\n');
  commitAll(fx.projectDir, 'main change');
  const head = run(['rev-parse', 'HEAD'], fx.projectDir).trim();
  const r = squashMerge({ ...fx, message: 'm' });
  assert.equal(r.merged, false);
  assert.equal(r.conflict, true);
  assert.deepEqual(r.files, ['a.txt']);
  assert.equal(run(['rev-parse', 'HEAD'], fx.projectDir).trim(), head);
  assert.equal(run(['status', '--porcelain'], fx.projectDir).trim(), '');
});

test('squashMerge:projectDir 有 tracked 未提交改动时拒绝', () => {
  const fx = makeFixture();
  write(fx.worktree, 'new.txt', 'x\n');
  commitAll(fx.worktree, 'c');
  write(fx.projectDir, 'a.txt', 'local edit\n'); // 用户自己的改动,不提交
  assert.throws(() => squashMerge({ ...fx, message: 'm' }), /未提交改动/);
});

test('squashMerge:projectDir detached HEAD 报错', () => {
  const fx = makeFixture();
  run(['checkout', '--detach'], fx.projectDir);
  assert.throws(() => squashMerge({ ...fx, message: 'm' }), /detached HEAD/);
});
```

- [ ] **Step 2: 运行测试,确认新增用例失败**

Run: `node --test server/gitReview.test.js`
Expected: Task 1 的 4 个 PASS;新增 5 个 FAIL,报 `squashMerge is not a function`

- [ ] **Step 3: 实现 `squashMerge`**

在 `server/gitReview.js` 的 `module.exports` 之前插入:

```js
function squashMerge({ projectDir, worktree, branch, message }) {
  const target = targetBranchOf(projectDir);

  // 用户自己的未提交改动不能代为处理;untracked 放行,若与合并内容碰撞由 git 自身安全中止
  const dirtyTracked = git(['status', '--porcelain'], projectDir).split('\n')
    .filter((l) => l.trim() && !l.startsWith('??'));
  if (dirtyTracked.length) {
    throw new Error(`项目目录有未提交改动(${dirtyTracked.length} 个文件),请先自行提交或撤销后再合并`);
  }
  try { git(['merge-base', target, branch], projectDir); }
  catch { throw new Error(`分支 ${branch} 与 ${target} 没有共同祖先,无法合并`); }

  // 收拢 worktree 未提交改动(含新文件)到 session 分支,不碰目标分支
  if (git(['status', '--porcelain'], worktree).trim()) {
    git(['add', '-A'], worktree);
    git(['commit', '-m', 'ccw: 合并前自动提交未落盘改动'], worktree);
  }

  // 无副作用冲突预检(git ≥ 2.38):退出码 1 = 有冲突,目标分支未被触碰
  const pre = gitLoose(['merge-tree', '--write-tree', '--name-only', target, branch], projectDir);
  if (pre.status === 1) {
    const lines = pre.stdout.split('\n');
    const blank = lines.indexOf('');
    const files = [...new Set(lines.slice(1, blank === -1 ? undefined : blank).filter(Boolean))];
    return { merged: false, conflict: true, target, files };
  }
  if (pre.status !== 0) throw new Error('冲突预检失败:' + pre.stdout.slice(0, 300));

  try {
    git(['merge', '--squash', branch], projectDir);
    git(['commit', '-m', message], projectDir);
  } catch (e) {
    try { git(['reset', '--merge'], projectDir); } catch { /* best effort */ }
    throw new Error('合并执行失败,项目目录已恢复:' + String(e.message).split('\n')[0]);
  }
  return { merged: true, target, hash: git(['rev-parse', '--short', 'HEAD'], projectDir).trim() };
}
```

并把 `module.exports` 改为:

```js
module.exports = { computeDiff, squashMerge, git, gitLoose, targetBranchOf };
```

- [ ] **Step 4: 运行测试,确认全部通过**

Run: `node --test server/gitReview.test.js`
Expected: 9 个测试全部 PASS

- [ ] **Step 5: 提交**

```bash
git add server/gitReview.js server/gitReview.test.js
git commit -m "gitReview.squashMerge:merge-tree 无副作用预检 + squash 合并"
```

---

### Task 3: manager 与 REST API 接线

**Files:**
- Modify: `server/manager.js`
- Modify: `server/index.js`

**Interfaces:**
- Consumes: Task 1/2 的 `computeDiff` / `squashMerge`。
- Produces(前端 Task 4 依赖):
  - `GET /api/sessions/:id/diff` → computeDiff 结果 JSON;错误 `400 { error }`。
  - `POST /api/sessions/:id/action` `{op:'merge'}` → squashMerge 结果 JSON(`{merged,target,hash}` 或 `{merged:false,conflict:true,target,files}`);错误 `400 { error }`。
  - `POST /api/sessions/:id/action` `{op:'resolve-conflict', value:{target, files}}` → `{ delivered: true }`;session 未运行时 `400 { error }`。

- [ ] **Step 1: manager.js 增加 diff / merge / resolveConflict**

`server/manager.js` 顶部 require 行(第 9 行附近)下方加:

```js
const { computeDiff, squashMerge } = require('./gitReview');
```

constructor 中 `this.runtime = new Map();` 之后加一行:

```js
    this._merging = new Set(); // projectDir 级合并互斥
```

在 `// ---------- lifecycle actions ----------` 注释之前插入:

```js
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
        this._event(s, 'warning', `合并被冲突预检拦下:${r.files.join('、')};${r.target} 未被改动`);
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
```

- [ ] **Step 2: index.js 增加路由,action 支持返回值与错误**

`server/index.js` 中现有 action 处理器(`app.post('/api/sessions/:id/action', ...)`)整体替换为:

```js
app.post('/api/sessions/:id/action', (req, res) => {
  const { op, value } = req.body || {};
  const id = req.params.id;
  const ops = {
    stop: () => manager.stop(id),
    restart: () => manager.restart(id),
    rename: () => manager.rename(id, value),
    archive: () => manager.archive(id, true),
    unarchive: () => manager.archive(id, false),
    delete: () => manager.remove(id),
    'refresh-brief': () => manager.refreshBrief(id),
    'flag-brief': () => manager.flagBrief(id),
    note: () => manager.setNote(id, value),
    merge: () => manager.merge(id),
    'resolve-conflict': () => manager.resolveConflict(id, value || {}),
  };
  if (!ops[op]) return res.status(400).json({ error: `未知操作 ${op}` });
  try {
    const out = ops[op]();
    res.json(out && typeof out === 'object' ? out : { ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
```

在 `app.post('/api/sessions/:id/input', ...)` 之前插入:

```js
// worktree session 的改动全览(含未提交与未跟踪文件)
app.get('/api/sessions/:id/diff', (req, res) => {
  try { res.json(manager.diff(req.params.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
```

- [ ] **Step 3: 起第二实例验证接线**

```bash
cd <repo>
node --check server/manager.js && node --check server/index.js
CCW_PORT=7180 node server/index.js &   # 或 run_in_background
sleep 1
# 创建一个 terminal session(无 worktree,不消耗 Claude)
curl -s -X POST http://127.0.0.1:7180/api/sessions -H 'Content-Type: application/json' \
  -d '{"type":"terminal","name":"wiring-test"}'
# 取返回的 id,替换下面的 <id>
curl -s -i http://127.0.0.1:7180/api/sessions/<id>/diff | head -1
curl -s http://127.0.0.1:7180/api/sessions/<id>/diff
curl -s -X POST http://127.0.0.1:7180/api/sessions/<id>/action -H 'Content-Type: application/json' -d '{"op":"merge"}'
curl -s http://127.0.0.1:7180/api/sessions/nonexist/diff
```

Expected:
- 两个 `node --check` 无输出(语法通过)
- `<id>/diff` → HTTP 400,`{"error":"该 session 没有独立 worktree,无法审阅/合并"}`
- `merge` → 同样 400 同样文案
- `nonexist/diff` → 400,`{"error":"session 不存在"}`

验证后清理:kill 第二实例进程,`rm -rf .ccw-data`(这是第二实例在本 worktree 下新建的数据目录,已 gitignore)。

- [ ] **Step 4: 提交**

```bash
git add server/manager.js server/index.js
git commit -m "API:GET /diff 与 merge/resolve-conflict action,项目级合并互斥"
```

---

### Task 4: 前端审阅覆盖层

**Files:**
- Modify: `public/app.js`
- Modify: `public/style.css`
- Modify: `public/index.html`(缓存戳 `?v=7` → `?v=8`,两处)

**Interfaces:**
- Consumes: Task 3 的 `GET /api/sessions/:id/diff`、action `merge`、action `resolve-conflict`;现有工具 `$`、`esc`、`api`、`act`、`toast`、`state`、`popover`。
- Produces: `openDiff(sessionId)`(入口按钮调用)。

- [ ] **Step 1: app.js 增加覆盖层模块**

在 `public/app.js` 的 `sendDecision` 函数之后、`/* ---------- workspace ---------- */` 注释之前插入:

```js
/* ---------- diff 审阅覆盖层 ---------- */
let diffCtx = null; // { id, data }

async function openDiff(id) {
  popover.hidden = true;
  try {
    const data = await api(`/api/sessions/${id}/diff`);
    diffCtx = { id, data };
    renderDiffOverlay();
  } catch (e) { toast('无法读取改动', e.message); }
}
function closeDiff() {
  const el = $('#diff-overlay');
  if (el) el.remove();
  diffCtx = null;
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDiff(); });

// 单文件着色:+/-/@@ 三色,其余 meta/上下文;全部转义
function diffFileHTML(chunk, i) {
  const lines = chunk.split('\n');
  const m = lines[0].match(/^diff --git a\/.* b\/(.*)$/);
  const fpath = m ? m[1] : lines[0];
  const body = lines.map((l) => {
    let c = 'ctx';
    if (/^(diff --git|index |new file|deleted file|Binary files|similarity|rename |\+\+\+|---)/.test(l)) c = 'meta';
    else if (l.startsWith('@@')) c = 'hunk';
    else if (l.startsWith('+')) c = 'add';
    else if (l.startsWith('-')) c = 'del';
    return `<span class="dl-${c}">${esc(l)}</span>`;
  }).join('\n');
  const pre = `<pre class="diff-text">${body}</pre>`;
  return `<section class="diff-file" id="dfile-${i}">
    <div class="diff-file-head">${esc(fpath)}</div>
    ${lines.length > 800 ? `<details><summary>${lines.length} 行改动,点击展开</summary>${pre}</details>` : pre}
  </section>`;
}

function renderDiffOverlay() {
  closeDiff();
  const { id, data } = diffCtx || {};
  const s = state.sessions.get(id);
  if (!s || !data) return;
  const totalAdd = data.files.reduce((n, f) => n + (f.add || 0), 0);
  const totalDel = data.files.reduce((n, f) => n + (f.del || 0), 0);
  const chunks = data.diff ? data.diff.split(/^(?=diff --git )/m).filter((c) => c.trim()) : [];
  const el = document.createElement('div');
  el.id = 'diff-overlay';
  el.innerHTML = `
    <div class="diff-head">
      <b>${esc(s.name)}</b>
      <span class="diff-branch">${esc(data.branch)} → ${esc(data.target)}</span>
      <span class="diff-stat"><i class="add">+${totalAdd}</i> <i class="del">−${totalDel}</i> · ${data.files.length} 个文件</span>
      ${data.behind ? `<span class="diff-warn">⚠ ${esc(data.target)} 已前进 ${data.behind} 条提交,可能有冲突</span>` : ''}
      ${data.truncated ? '<span class="diff-warn">diff 过大已截断,完整内容请进终端查看</span>' : ''}
      <span style="flex:1"></span>
      <button class="btn-ghost" id="diff-refresh">刷新</button>
      <button class="btn-primary" id="diff-merge">合并到 ${esc(data.target)}</button>
      <button class="btn-ghost" id="diff-close">关闭</button>
    </div>
    <div id="diff-banner" hidden></div>
    <div class="diff-body">
      <nav class="diff-nav">${data.files.map((f, i) => `
        <a data-i="${i}"><span class="p">${esc(f.path)}</span>
          <span class="n">${f.add == null ? '二进制' : `+${f.add} −${f.del}`}</span></a>`).join('')}
      </nav>
      <div class="diff-main">${chunks.map(diffFileHTML).join('') || '<div class="empty"><strong>没有改动</strong></div>'}</div>
    </div>`;
  document.body.appendChild(el);
  $('#diff-close', el).onclick = closeDiff;
  $('#diff-refresh', el).onclick = () => openDiff(id);
  el.querySelectorAll('.diff-nav a').forEach((a) => a.onclick = () => {
    const t = $(`#dfile-${a.dataset.i}`, el);
    if (t) t.scrollIntoView({ behavior: 'smooth' });
  });
  $('#diff-merge', el).onclick = async () => {
    const btn = $('#diff-merge', el);
    btn.disabled = true; btn.textContent = '合并中…';
    try {
      const r = await act(id, 'merge');
      if (r.merged) {
        toast(`已合并到 ${r.target}(${r.hash})`, '点击可归档该 session', () => act(id, 'archive'));
        closeDiff();
        return;
      }
      if (r.conflict) showConflict(id, r);
    } catch (e) {
      toast('合并失败', e.message);
    }
    btn.disabled = false; btn.textContent = `合并到 ${data.target}`;
  };
}

function showConflict(id, r) {
  const b = $('#diff-banner');
  if (!b) return;
  b.hidden = false;
  b.innerHTML = `<b>合并有冲突,${esc(r.target)} 未被改动。</b>冲突文件:${r.files.map(esc).join('、')}
    <button class="btn-ghost" id="diff-resolve">让 Claude 解决冲突</button>`;
  $('#diff-resolve').onclick = async () => {
    try {
      await act(id, 'resolve-conflict', { target: r.target, files: r.files });
      toast('已发送指令', 'Claude 将在其 worktree 中解决冲突,完成后可重新合并');
      closeDiff();
    } catch (e) { toast('发送失败', e.message); }
  };
}
```

- [ ] **Step 2: 两个入口**

(a) `cardHTML` 中,`<div class="card-line">…</div>` 之后、`${d && d.question ? …}` 之前插入:

```js
    ${s.status === 'review_ready' && s.worktree ? `<div class="card-review"><button class="review-btn">审阅改动</button></div>` : ''}
```

(b) `wireCards` 的 click 处理器中,`const btn = e.target.closest('.opt-btn');` 之前插入:

```js
      const rb = e.target.closest('.review-btn');
      if (rb) {
        e.stopPropagation();
        openDiff(el.dataset.id);
        return;
      }
```

(c) `renderWorkspace` 的 `.ws-actions` 里,`<button class="btn-ghost" id="ws-refresh">刷新摘要</button>` 之前插入:

```js
        ${s.worktree ? '<button class="btn-ghost" id="ws-review">审阅改动</button>' : ''}
```

并在 `$('#ws-refresh').onclick = …` 之前加一行:

```js
  if (s.worktree) $('#ws-review').onclick = () => openDiff(s.id);
```

- [ ] **Step 3: style.css 追加覆盖层样式**

`public/style.css` 末尾(`@media` 块之前)追加:

```css
/* ---------- diff 审阅覆盖层 ---------- */
#diff-overlay { position: fixed; inset: 0; z-index: 90; background: var(--bg); display: flex; flex-direction: column; }
.diff-head { display: flex; align-items: center; gap: 12px; padding: 12px 20px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.diff-head b { font-size: 15px; }
.diff-branch { font-family: var(--mono); font-size: 12px; color: var(--muted); }
.diff-stat { font-family: var(--mono); font-size: 12px; color: var(--faint); }
.diff-stat .add { color: var(--c-review_ready); font-style: normal; }
.diff-stat .del { color: var(--c-needs_permission); font-style: normal; }
.diff-warn { font-size: 12px; color: var(--c-needs_decision); }
#diff-banner {
  padding: 10px 20px; font-size: 13px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
  background: color-mix(in srgb, var(--c-blocked) 12%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--c-blocked) 45%, transparent);
}
.diff-body { flex: 1; display: flex; min-height: 0; }
.diff-nav { width: 280px; flex: 0 0 280px; overflow-y: auto; border-right: 1px solid var(--border); padding: 10px; }
.diff-nav a { display: flex; justify-content: space-between; gap: 8px; padding: 6px 8px; border-radius: 6px; cursor: pointer; font-size: 12.5px; }
.diff-nav a:hover { background: var(--raised); }
.diff-nav .p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diff-nav .n { font-family: var(--mono); font-size: 11px; color: var(--faint); white-space: nowrap; }
.diff-main { flex: 1; overflow-y: auto; padding: 14px 20px; min-width: 0; }
.diff-file { margin-bottom: 18px; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.diff-file-head { font-family: var(--mono); font-size: 12.5px; padding: 8px 12px; background: var(--panel); border-bottom: 1px solid var(--border); }
.diff-text { font-family: var(--mono); font-size: 12px; line-height: 1.5; padding: 10px 12px; overflow-x: auto; background: #0e1013; }
.diff-text span { display: inline-block; width: 100%; }
.dl-add { color: #7ddba3; background: rgba(69, 201, 142, .09); }
.dl-del { color: #ff9c88; background: rgba(244, 105, 77, .09); }
.dl-hunk { color: var(--c-verifying); }
.dl-meta { color: var(--faint); }
.dl-ctx { color: #a9b1bd; }
.diff-file details summary { padding: 8px 12px; cursor: pointer; color: var(--muted); font-size: 12.5px; }
.card-review { margin-top: 10px; }
.review-btn {
  border: 1px solid color-mix(in srgb, var(--c-review_ready) 45%, transparent);
  color: var(--c-review_ready); border-radius: 8px; padding: 5px 12px; font-size: 12.5px;
}
.review-btn:hover { background: color-mix(in srgb, var(--c-review_ready) 10%, transparent); }
```

- [ ] **Step 4: index.html 缓存戳升级**

`public/index.html` 两处 `?v=7` 改为 `?v=8`:

```html
<link rel="stylesheet" href="/style.css?v=8">
```
```html
<script src="/app.js?v=8"></script>
```

- [ ] **Step 5: 语法检查**

Run: `node --check public/app.js`
Expected: 无输出(通过)

- [ ] **Step 6: 提交**

```bash
git add public/app.js public/style.css public/index.html
git commit -m "前端:全屏 diff 审阅层,一键合并/冲突横幅,review_ready 卡片与 workspace 入口"
```

---

### Task 5: 文档更新 + 端到端验收

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: 全部前序任务。

- [ ] **Step 1: README 更新**

「已实现(对照 PRD)」列表末尾(`- 普通终端永远是…` 之前)插入:

```markdown
- **Diff 审阅与一键合并**:worktree session 的全部改动(含未提交与新文件)在网页审阅层查看;squash 一键合并回项目当前分支,提交信息自动带 session 名与任务目标;冲突由 `git merge-tree` 预检拦下、主分支分毫不动,可一键让 Claude 在其 worktree 内解决后重试。
```

「MVP 未做」里的这一行:

```markdown
- 容器级执行隔离、项目视图聚合、手机 Push、PR 审阅等 PRD 明确的后续项。
```

改为:

```markdown
- 容器级执行隔离、项目视图聚合、手机 Push 等 PRD 明确的后续项。
```

- [ ] **Step 2: 全量回归**

Run: `node --test server/gitReview.test.js && node --check server/index.js && node --check server/manager.js && node --check public/app.js`
Expected: 9 个测试 PASS,三个 check 无输出

- [ ] **Step 3: 提交**

```bash
git add README.md
git commit -m "README:记录 diff 审阅与一键合并"
```

- [ ] **Step 4: 端到端手工验收(需真实 Claude 环境,对照规格验收标准)**

在真实 Workbench 实例(或 `CCW_PORT=7180` 第二实例)上:

1. 新建 Claude session(勾选 worktree 隔离),任务:「在 README 末尾加一行测试文字,并新建 scratch.txt 写入 hello,不要 commit」。
2. 等 session 到 `review_ready`:Inbox 卡片出现「审阅改动」按钮;点击 → 覆盖层展示 README 修改与 scratch.txt 新文件(验收标准 1:两次点击内看到完整 diff)。
3. 点「合并到 main」→ toast 显示短 hash;在项目目录 `git log -1 --stat` 确认恰好一条 squash 提交、包含两个文件、提交信息带 session 名与任务;`git status` 干净(验收标准 2)。
4. 冲突场景:再开一个 worktree session 改某文件同一行,同时在项目目录手动改同一行并 commit;点合并 → 冲突横幅出现、`git log` 确认 main 无新提交;点「让 Claude 解决冲突」→ session 终端里收到指令(验收标准 3)。
5. 普通终端 session:卡片与 workspace 均无「审阅改动」入口(验收标准 4)。

全部通过后,此功能完成。
