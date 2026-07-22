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

// 分支名可用 `git branch -- -foo` 造出以 - 开头的形态,直接拼进 argv 会被当成选项解析
function assertSafeRef(name, label) {
  if (!name || name.startsWith('-')) throw new Error(`${label}「${name}」以 - 开头或为空,拒绝操作`);
}

function computeDiff({ projectDir, worktree, branch }) {
  const target = targetBranchOf(projectDir);
  assertSafeRef(target, '目标分支');
  assertSafeRef(branch, 'session 分支');
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

function squashMerge({ projectDir, worktree, branch, message }) {
  const target = targetBranchOf(projectDir);
  assertSafeRef(target, '目标分支');
  assertSafeRef(branch, 'session 分支');

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

module.exports = { computeDiff, squashMerge, git, gitLoose, targetBranchOf };
