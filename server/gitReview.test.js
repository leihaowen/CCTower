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
