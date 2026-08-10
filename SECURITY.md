# 安全策略 / Security Policy

## 报告漏洞 / Reporting a vulnerability

**请不要在公开 issue 里提交漏洞或 PoC。**

请走 GitHub 的私密通道:仓库 **Security → Advisories → Report a vulnerability**。
这会开一个只有维护者可见的私密讨论,可以安全地贴 PoC。

请尽量包含:影响的版本 / commit、复现步骤、你认为的影响面(能读什么、能改什么、能不能执行命令)。

> **English:** please do not open a public issue for security problems. Use GitHub's private
> reporting: **Security → Advisories → Report a vulnerability**. Include affected version/commit,
> reproduction steps, and the impact you believe it has. This is a personal side project —
> best-effort response, typically within a week.

CCTower 是个人业余项目,没有 SLA。我会尽力在一周内回应;确认的问题会在修复后发布 advisory
并在 release notes 里致谢(你也可以要求匿名)。

## 支持的版本

只有 `main` 分支的最新提交会收到修复。目前没有长期支持分支。

## 设计前提(信任模型)

理解这几条才能判断什么算漏洞:

1. **CCTower 的本质是一个能在你机器上执行任意命令的工具。** 它按设计就可以创建终端会话、
   运行任意命令、以 `bypassPermissions` 启动 agent。因此"通过 CCTower 执行了命令"本身不是漏洞——
   **绕过它的访问控制去执行命令**才是。
2. **它假设自己跑在单用户机器上,只服务于运行它的那个账号。** 同机其他本地用户能拿到的东西
   (见下面"已知限制")不算漏洞,但欢迎讨论如何收紧。
3. **默认只绑 `127.0.0.1`,不设令牌。** 一旦配置成对外可达(`CCW_HOST` 非回环,或设了
   `CCW_ALLOWED_HOSTS`),服务会**强制要求 `CCW_TOKEN`,否则拒绝启动**。
4. **Host / Origin 校验只防浏览器**(CSRF、DNS rebinding)。它挡不住 `curl` ——Host 头是
   请求方可控的。对外部署时,令牌是唯一的认证边界。

## 已知限制

这些是当前设计的已知短板,不必再作为新漏洞报告(但欢迎带方案的改进 PR):

- **给 agent 的令牌是全权令牌。** `CCW_TOKEN` 会注入每个会话的环境(供 hooks 与 MCP 上报回调
  使用),而它同时也是整个 API 的凭据。这意味着一个被 prompt injection 的 agent 可以用它调用
  任意 API:创建终端会话执行命令(绕过 Claude Code 的权限弹窗)、把分支合并进主分支、删除其他会话。
  **计划的修法**:改为按会话签发降权令牌,只放行 `/api/hook/:id` 与 `/api/report/:id`。
  在此之前:不要让 CCTower 里的 agent 去处理你不信任的代码库或输入。
- **令牌会出现在进程命令行。** hooks 是 `curl -H 'X-CCW-Token: …'` 形式,配置文件本身是 `0600`,
  但同机其他用户可以通过 `ps aux` 看到 argv 里的令牌。
- **`bypassPermissions` 权限模式下 agent 不受任何确认约束。** 请配合独立 worktree 使用;
  拿不准就用默认的"每次询问"。
- **飞书通知会把会话摘要发到外部 webhook**,内容包含任务目标与状态行,可能含项目信息。
  该功能默认关闭。
- **AI 归纳(`claude -p`)会把近期事件与终端画面尾部(约 1500 字符)发给模型**,消耗你自己的
  Claude 额度。若你的终端里出现过密钥,它可能进入这段材料。

## 已经做了的加固

- 默认只绑回环;对外暴露时强制令牌(`server/authGuard.js`,启动即校验)
- API 与 WebSocket 校验 Host 与 Origin;令牌走 WebSocket 子协议而非 URL(不进代理日志与浏览器历史)
- 令牌常数时间比较,长度不匹配返回 401 而不是抛错
- 目录浏览接口限制在 home 与启动目录(或 `CCW_BROWSE_ROOTS`),经 `realpath` 校验,防 `..` 与
  符号链接逃逸
- 会话启动参数白名单:拒绝覆盖平台自有标志(`--settings` / `--mcp-config` /
  `--append-system-prompt` / `--permission-mode` / `--dangerously-skip-permissions` 等),
  权限模式仅接受已知取值
- 所有 git 调用走 `execFileSync` 传参数数组(不经 shell);分支名以 `-` 开头一律拒绝
- 前端所有插入 DOM 的文本统一转义,包括 diff 内容与 agent 上报的摘要
- 凭据类文件以 `0600` 写入,`.ccw-data/` 已被 `.gitignore` 忽略
- 终端逐键输入不落盘(可能含密码),只记录显式的决策/权限/合并操作
