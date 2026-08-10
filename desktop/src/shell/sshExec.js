// 薄胶水:把 Tauri Command 包成与 core/tunnel.js 期望的 spawn 契约同形状的适配器。
// 安全加固(controller ruling):不用 args:true 的宽松 shell 权限,capabilities/default.json
// 里给 ssh-tunnel / ssh-run 各自配了逐位置正则白名单,这里对应用两个命名 scope 调用。
import { Command } from '@tauri-apps/plugin-shell';

// 返回与 core/tunnel.js 的 spawn 契约同形状的适配器
export function tauriSpawn() {
  return (args) => {
    const cmd = Command.create('ssh-tunnel', args);
    const exitCbs = [], errCbs = [];
    let child = null, wantKill = false;
    cmd.stderr.on('data', (line) => errCbs.forEach((f) => f(String(line))));
    cmd.on('close', (data) => exitCbs.forEach((f) => f(data.code)));
    cmd.spawn().then((c) => { child = c; if (wantKill) c.kill(); });
    return {
      kill: () => { wantKill = true; if (child) child.kill(); },
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
