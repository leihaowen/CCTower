'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { computeDiff, squashMerge } = require('../server/gitReview');

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

test('computeDiff:含空格与中文名的未跟踪文件完整出现在 diff', () => {
  const fx = makeFixture();
  write(fx.worktree, 'has space.txt', 'secret1\n');
  write(fx.worktree, '设计文档.md', 'secret2\n');
  const d = computeDiff(fx);
  assert.ok(d.diff.includes('+secret1'));
  assert.ok(d.diff.includes('+secret2'));
  const paths = d.files.map((f) => f.path);
  assert.ok(paths.includes('has space.txt'));
  assert.ok(paths.includes('设计文档.md'));
});

test('安全:以 - 开头的分支名被拒绝,不会进入 git argv', () => {
  const fx = makeFixture();
  run(['symbolic-ref', 'HEAD', 'refs/heads/-evil'], fx.projectDir);
  assert.throws(() => computeDiff(fx), /以 - 开头/);
  assert.throws(() => squashMerge({ ...fx, message: 'm' }), /以 - 开头/);
});
