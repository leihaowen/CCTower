// 薄胶水:webview 原生 WebSocket;断线自动重连(3s 固定间隔,隧道层已有退避)
export function connectEvents({ localPort, token, onMessage, onDown }) {
  const protocols = token ? [`ccw.token.${b64url(token)}`] : [];
  let ws = null, closed = false, retryTimer = null;
  const open = () => {
    if (closed) return; // close 之后不允许任何路径再开新连接
    ws = new WebSocket(`ws://127.0.0.1:${localPort}/ws/events`, protocols);
    ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch { /* 非 JSON 忽略 */ } };
    ws.onclose = () => { if (!closed) { onDown(); retryTimer = setTimeout(open, 3000); } };
  };
  open();
  return {
    close: () => {
      closed = true;
      if (retryTimer != null) { clearTimeout(retryTimer); retryTimer = null; }
      try { ws && ws.close(); } catch { /* 已关闭忽略 */ }
    },
  };
}

function b64url(s) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
