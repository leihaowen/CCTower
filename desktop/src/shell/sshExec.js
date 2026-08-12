// 薄胶水:把 Tauri Command 包成与 core/tunnel.js 期望的 spawn 契约同形状的适配器。
// 安全加固(controller ruling):不用 args:true 的宽松 shell 权限,capabilities/default.json
// 里给 ssh-tunnel / ssh-run 各自配了逐位置正则白名单,这里对应用两个命名 scope 调用。
import { Command } from '@tauri-apps/plugin-shell';

// 返回与 core/tunnel.js 的 spawn 契约同形状的适配器
export function tauriSpawn() {
  return (args) => {
    const cmd = Command.create('ssh-tunnel', args);
    const exitCbs = [], errCbs = [];
    let child = null, wantKill = false, exited = false;
    // spawn 失败必须走 onExit,否则隧道卡在 connecting 永不重试:
    // 'error'(ACL 拒绝、找不到可执行文件等)和 spawn() 被 reject 都得触发一次退出回调,
    // 用非零 code 让 Tunnel 走 retrying(除非 stderr 命中 AUTH_FAIL_RE)。
    const fireExit = (code) => { if (exited) return; exited = true; exitCbs.forEach((f) => f(code)); };
    cmd.stderr.on('data', (line) => errCbs.forEach((f) => f(String(line))));
    cmd.on('error', (err) => { errCbs.forEach((f) => f(String(err))); fireExit(-1); });
    cmd.on('close', (data) => fireExit(data.code));
    cmd.spawn()
      .then((c) => { child = c; if (wantKill) c.kill(); })
      .catch((err) => { errCbs.forEach((f) => f(String(err))); fireExit(-1); });
    return {
      // 返回 kill 的 Promise:退出应用前要 await,否则进程先消失,ssh 会被系统收养
      // (PPID → 1)继续占着本地端口,下次启动就抢不到。
      kill: () => {
        wantKill = true;
        return child ? child.kill() : Promise.resolve();
      },
      onExit: (cb) => exitCbs.push(cb),
      onStderr: (cb) => errCbs.push(cb),
    };
  };
}

// 一键启动等一次性命令:跑完返回 {code, stderr}
export async function sshRun(args) {
  const out = await Command.create('ssh-run', args).execute();
  return { code: out.code, stderr: out.stderr };
}
