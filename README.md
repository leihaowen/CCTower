# Agent Workbench — MVP 原型

基于 `PRD` 实现的网页化 AI 终端工作台原型:并行运行多个 Claude Code / 终端 session,用 Attention Inbox 回答「哪件事需要我、我该怎么回应」。

## 运行

```bash
npm install        # 首次
npm start          # 默认 http://127.0.0.1:7080(可用 CCW_PORT 改端口)
```

只绑定 localhost。session 数据存放在 `.ccw-data/`(已 gitignore)。

## 已实现(对照 PRD)

- **Session 生命周期**:创建 Terminal / Claude Code session(名称、项目目录、初始任务),停止、重启、重命名、归档、删除;浏览器刷新/断线不影响后台 PTY。
- **Worktree 隔离**:Claude session 默认在 `.ccw-data/worktrees/<id>` 创建独立 worktree + `ccw/<id>` 分支;仓库无 commit 或非 Git 目录时降级为直接运行并写入警告事件;删除 session 时清理 worktree 与分支。
- **网页终端**:xterm.js,支持输入、复制粘贴、resize、滚动回看、断线缓冲区回放;多标签页只有一个输入控制者,其余只读,可「接管控制」。
- **Claude 状态采集**:启动 Claude 时注入 `--settings`(Notification / Stop / SubagentStop / SessionEnd / UserPromptSubmit hooks 经 curl 回传)+ `--append-system-prompt`(report_status 协议:agent 在任务开始、阶段完成、阻塞/决策、结束时 POST 结构化 JSON)。不解析终端文字判断状态。
- **状态机**:executing / verifying / needs_decision / needs_permission / blocked / review_ready / completed / stale / terminal_only / exited,来源标注(系统观测 / Agent 上报 / 用户操作),同一原因通知去重、用户回应后解除。
- **Attention Inbox**:权限 > 决策 > 阻塞 > 待审四组置顶,卡片悬停约 400ms 展示 Brief(目标/进度/待决策/推荐/下一步/证据/来源);决策选项可直接点击,答案写回原 PTY 并记入决策时间线。
- **All Sessions**:按活跃/需注意/归档、类型筛选。
- **Session Workspace**:左 Brief + 元数据 + 回复框 + 手工备注,中终端,右事件时间线与决策历史。
- **通知**:页面内 toast + 可选浏览器桌面通知(仅 needs_decision / needs_permission / blocked / review_ready 触发)。
- 普通终端永远是 `terminal_only` / `exited`,report/hook 对其无效(验收标准 7)。

## MVP 未做(与 PRD 一致或原型简化)

- AI 归纳摘要未接模型:「刷新摘要」基于系统观测事件重建(来源如实标注),Agent 上报优先级更高、不被覆盖。
- 容器级执行隔离、项目视图聚合、手机 Push、PR 审阅等 PRD 明确的后续项。
- 服务进程重启后 PTY 不可恢复(PRD 只要求浏览器刷新存活),session 会标记为「已退出,可重启」。

## 开工前决策的取值(PRD §11)

1. 纯本地应用,只绑定 `127.0.0.1`。
2. 允许在网页终端输入任意 shell 命令(单用户个人工具)。
3. 复用本机已登录的 Claude Code CLI,不引入平台侧模型调用。
4. worktree 创建失败时不阻止运行:降级为项目目录直跑,并在事件时间线给出冲突风险警告。

## 结构

```
server/index.js       HTTP + WebSocket 路由、REST API
server/manager.js     Session 管理:PTY、缓冲回放、状态机、Brief、worktree、持久化
server/claudeSetup.js Claude hooks 设置文件与 report_status 协议提示词
public/               无构建前端(index.html / app.js / style.css + xterm.js)
```
