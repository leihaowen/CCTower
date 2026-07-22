# 设计:diff 审阅 + 一键合并

> 日期:2026-07-22
> 状态:已确认
> 对应 PRD §11「MVP 后再做」第一条:PR / diff 审阅与一键合并

## 背景与目标

Claude session 在独立 worktree(分支 `ccw/<id>`)上工作,到 `review_ready` 后用户目前必须进终端手动 `git diff` / `git merge`。本功能把「Attention Inbox → 看 Brief → 审 diff → 合并」闭环收进网页:用户在审阅层看到 session 的全部改动,一键 squash 合并回主分支。

## 已确认的产品决策

1. **合并方式:squash。** 所有改动压成一条提交落到目标分支,提交信息自动带 session 名与任务目标。不保留 Claude 的中间提交。
2. **未提交改动:一并纳入。** diff 对比「worktree 工作区 vs 合并基点」,审的是最终结果;合并时自动把未提交改动 commit 进 session 分支再 squash。
3. **冲突绝不留给 main。** 合并前无副作用预检;有冲突则中止、main 分毫不动,提供「让 Claude 解决冲突」按钮,向该 session 发指令在其 worktree 内解决后用户再重试合并。
4. **实现取向:零新依赖。** 自绘 unified diff 渲染 + 全屏审阅层,与项目「无构建、原生 JS、依赖只有 xterm」的风格一致。

## 适用范围

仅对 `s.worktree` 非空的 Claude session 生效(即成功创建了隔离 worktree 的 session)。普通终端、降级直跑的 session 不显示入口,API 返回 400。

## 架构与新增文件

```
server/gitReview.js        computeDiff() / squashMerge():输入路径与元数据,输出结构化结果;
                           不持有状态,git 调用全部 execFileSync
server/gitReview.test.js   node 内建 test runner(node --test),临时目录搭真实 git 仓库
server/index.js            + GET /api/sessions/:id/diff;action 增加 merge / resolve-conflict
server/manager.js          merge 结果写事件时间线与决策历史;项目级合并互斥锁
public/app.js              审阅覆盖层 + diff 渲染器(约 150 行)
public/style.css           覆盖层样式
```

## Diff 读取:`GET /api/sessions/:id/diff`

- **合并目标 = projectDir 当前 checkout 的分支**(运行时读 `git symbolic-ref --short HEAD`,不硬编码 main;detached HEAD 报错)。
- **diff 基点 = `merge-base(目标分支, worktree HEAD)`**:只含 session 自己的改动,目标分支后来前进的部分不掺入。
- **对比到工作区**(而非 HEAD),未提交改动自然包含。
- **未跟踪新文件**:对 `git status --porcelain` 列出的 untracked 逐个 `git diff --no-index /dev/null <file>` 拼接,不动 worktree 的 index(Claude 无感知);二进制文件只列文件名不展开。gitignore 的文件天然排除。
- **返回结构**:

```json
{
  "target": "main",
  "branch": "ccw/xxxx",
  "behind": 2,
  "files": [{ "path": "src/a.js", "add": 10, "del": 3 }],
  "diff": "diff --git a/src/a.js b/src/a.js\n...",
  "truncated": false
}
```

- `behind` = 目标分支领先 worktree HEAD 的提交数(`git rev-list --count HEAD..<target>`),用于「主分支已前进,可能冲突」提示。
- diff 文本超过 1MB 截断并置 `truncated: true`;`files` 列表(numstat)始终完整。

## 一键合并:action `merge`

顺序执行,任何一步失败都不改动目标分支:

1. **前置检查**
   - 目标分支非 detached HEAD,否则报错「请先在项目目录 checkout 到分支」。
   - projectDir `git status --porcelain` 中 tracked 文件必须干净(用户自己的未提交改动不能代为处理,报错提示);untracked 文件放行,若与合并内容冲突由 git 自身安全中止。
2. **自动收拢**:worktree 有未提交改动 → `git add -A && git commit -m "ccw: 合并前自动提交未落盘改动"`(提交到 `ccw/<id>` 分支,不碰 main)。
3. **冲突预检**:在 projectDir 执行 `git merge-tree --write-tree <target> <branch>`(纯 plumbing,零副作用;本机 git 2.39.5 ≥ 2.38 支持)。退出码非 0 → 解析 stdout 冲突文件列表,返回 `{ merged: false, conflict: true, files: [...] }`。
4. **落地**:`git merge --squash <branch>` + `git commit`。提交信息:
   - 第一行:`ccw: <session 名>`
   - 正文:任务目标(brief.objective 或初始 command)、session id、来源分支。
   - 异常时 `git reset --merge` 恢复 projectDir,返回错误。
5. **善后**
   - 成功:事件时间线记「已 squash 合并到 <target>(<短 hash>)」,决策历史记一条;响应带短 hash;**不自动归档**,前端 toast 提供「归档」快捷入口。
   - 互斥:同一 projectDir 同时只允许一个合并(内存锁),并发请求返回「另一合并正在进行」。

## 冲突流:action `resolve-conflict`

预检报冲突后,覆盖层顶部显示横幅(冲突文件列表 + 「让 Claude 解决冲突」按钮)。点击后复用现有 `sendInput` 通道向该 session 发送固定指令:

> 请在你的 worktree 中执行 `git merge <target>`,解决以下文件的冲突并验证后 commit,完成后上报 review:<文件列表>

指令记入决策历史。Claude 解决后回到 `review_ready`,用户重新发起合并。

## 前端审阅层

- **入口**:Workspace 头部「审阅改动」按钮(有 worktree 才渲染);`review_ready` 卡片加同名快捷按钮(复用卡片按钮的事件委托模式,阻止冒泡)。
- **布局**:全屏覆盖层(不销毁底下的终端连接)。
  - 顶栏:session 名、`ccw/xxx → main`、总 +N/−M、behind 提示、刷新 / 「合并到 <target>」 / 关闭。
  - 左栏:文件列表,每项带 +/− 数,点击滚动到对应文件。
  - 右侧:diff 正文,按文件分块。
- **渲染器**:按 `diff --git` 切文件;`+` / `-` / `@@` 行三色着色;所有内容 HTML 转义;单文件超 800 行折叠为「N 行改动,点击展开」。零依赖。
- **合并交互**:点合并 → 按钮进入 loading → 成功:toast(短 hash + 归档入口)、关闭覆盖层;冲突:显示冲突横幅;错误:toast 展示后端 message。

## 错误处理一览

| 情形 | 行为 |
|---|---|
| session 无 worktree | 不显示入口;API 400 |
| worktree 目录损坏/被删 | 报错并写入事件时间线 |
| projectDir 有未提交改动(tracked) | 拒绝合并,提示用户先自行处理 |
| projectDir detached HEAD | 拒绝,提示 checkout 到分支 |
| 目标分支与 session 分支无共同祖先 | 报错(异常场景,不强合) |
| squash 中途异常 | `git reset --merge` 恢复,报错 |
| diff 超 1MB | 截断展示 + `truncated` 标注 |
| 并发合并同一项目 | 后到者拒绝 |

## 测试

`server/gitReview.test.js`,node 24 内建 test runner,每个用例在临时目录搭真实 git 仓库(主仓 + worktree):

1. 干净合并:分支改动 squash 落到 main,main 一条新提交,工作区干净。
2. 含未提交改动的合并:worktree dirty → 自动 commit → 合并结果包含这些改动。
3. untracked 新文件出现在 computeDiff 输出且参与合并。
4. 冲突预检:main 与分支改同一行 → 返回冲突文件列表,main 无任何改动。
5. 脏 projectDir(tracked 改动)→ 拒绝。
6. detached HEAD → 拒绝。
7. diff 截断:超大文件 → `truncated: true` 且 files 完整。

前端渲染与整体流程以手工验收为主:创建真实 Claude session 改文件 → 审阅层核对 diff → 合并 → 验证 main 提交与事件时间线。

## 验收标准

1. `review_ready` 的隔离 session,从 Inbox 卡片两次点击内可看到完整 diff(含未提交与新增文件)。
2. 一键合并后目标分支恰好多一条 squash 提交,提交信息含 session 名与任务目标;projectDir 工作区干净。
3. 构造冲突场景:合并被预检拦下,main 无任何改动;点「让 Claude 解决冲突」后指令送达该 session 终端。
4. 非隔离 session 看不到审阅入口。
5. `node --test server/gitReview.test.js` 全绿。
