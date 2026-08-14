import { spawn } from 'node:child_process';

// 与 shell/sshExec.js 的 Tauri 适配器同契约,供 node 环境(集成测试/E2E)使用
//
// detached: true 让子进程自成一个进程组(组长 pid == child.pid)。
// 假 ssh 脚本里 `sleep 3600` 是脚本 fork 出来的孙进程:若只对 child.pid
// 发 SIGTERM,bash 脚本本身退出了,但 sleep 不会被一并终止,会变成孤儿
// 进程残留。改为对 -child.pid(负数 pid = 整个进程组)发信号,连同子孙
// 进程一并杀掉,避免测试跑完后系统里还挂着 sleep 3600。
export function nodeSpawn(bin) {
  return (args) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    return {
      kill: () => {
        try { process.kill(-child.pid, 'SIGTERM'); }
        catch { try { child.kill('SIGTERM'); } catch { /* 进程已退出,忽略 */ } }
      },
      onExit: (cb) => child.on('exit', (code) => cb(code)),
      onStderr: (cb) => child.stderr.on('data', (d) => cb(String(d))),
    };
  };
}
