// E2E:对真实 CCTower 服务端(server/index.js)验证 WS 契约与回环 Host/Origin 放宽。
// 场景模拟隧道穿透:客户端携带的 Host 端口与服务端实际监听端口不同,
// Origin 是 Tauri webview 的 `tauri://localhost`,验证 Task 1 的回环放宽逻辑
// (server/authGuard.js 的 isLoopbackHostHeader,接入 isLocalRequest)确实生效,
// 且真实服务端推送的 snapshot 消息能被 Task 7 的 applyMessage 归约器直接消费。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import WebSocket from 'ws';
import { createState, applyMessage } from '../src/core/watcher.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// 刻意放在 core/ports.js 的 17080–17999 之外:那个区间是客户端隧道的动态端口池,
// 真机上跑测试时有可能正好有条隧道占着这里,测试就会因为 EADDRINUSE 莫名失败。
const PORT = 18977;

// 起真服务端比纯逻辑测试慢得多,而 node --test 会并行跑多个测试文件抢 CPU,
// 预算给太紧会变成偶发失败(实测 10 秒会偶发超时)。给足时间,真起不来照样会失败。
async function waitHttp(url, ms = 30000) {
  const t0 = Date.now();
  let lastErr = '';
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch (e) { lastErr = e.message; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`服务端起不来(等了 ${ms}ms,${url}${lastErr ? ',最后一次错误:' + lastErr : ''})`);
}

test('真服务端:伪造隧道 Host + tauri Origin 仍能连 WS 并拿到 snapshot', async () => {
  // 用临时目录隔离数据,避免污染仓库或其它测试的状态
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-e2e-'));
  const srv = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, CCW_PORT: String(PORT), CCW_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // 服务端日志仅用于排障,平时忽略,避免刷屏
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', () => {});
  try {
    await waitHttp(`http://127.0.0.1:${PORT}/`);
    const msg = await new Promise((resolve, reject) => {
      // 模拟隧道场景:Host 端口与服务端端口不同;Origin 是 Tauri webview 的
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/events`, [], {
        headers: { Host: '127.0.0.1:29999', Origin: 'tauri://localhost' },
      });
      ws.on('message', (d) => { resolve(JSON.parse(String(d))); ws.close(); });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('等 snapshot 超时')), 15000);
    });
    assert.equal(msg.type, 'snapshot');
    assert.ok(Array.isArray(msg.sessions));
    const st = createState();
    applyMessage(st, 'e2e', msg); // 契约:归约器能直接消费真实消息
  } finally {
    // 无论成功还是断言失败都要杀掉子进程、清理临时目录,防止残留
    srv.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
