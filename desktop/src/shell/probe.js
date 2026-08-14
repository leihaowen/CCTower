// 薄胶水:plugin-http 走 Rust 侧请求,绕开 webview 对 http:// 本地地址的 CORS 限制
import { fetch } from '@tauri-apps/plugin-http';

export async function httpProbe(localPort) {
  try {
    const r = await fetch(`http://127.0.0.1:${localPort}/`, { method: 'GET', connectTimeout: 1500 });
    return r.status < 500;
  } catch { return false; }
}
