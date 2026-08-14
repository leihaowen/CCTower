'use strict';
const http = require('node:http');
const { Store } = require('./src/store');
const { Hub } = require('./src/hub');
const { createApp } = require('./src/app');

const store = new Store();
const config = store.getConfig();
if (!config.passwordHash) {
  console.error('还没有设置登录密码。先运行:node gateway/cli.js set-password');
  process.exit(1);
}

// 网关自己只听回环,TLS 与公网入口交给前面的 Caddy(见 deploy/Caddyfile.example)
const PORT = Number(process.env.CCTOWER_GATEWAY_PORT || config.port || 7081);
const HOST = process.env.CCTOWER_GATEWAY_HOST || '127.0.0.1';
// 只在本地 http 调试时设 1;线上走 HTTPS 必须保持 Secure cookie
const secureCookie = process.env.CCTOWER_GATEWAY_INSECURE_COOKIE !== '1';

const hub = new Hub({ store });
const { app, handleUpgrade } = createApp({ store, hub, secureCookie });
const server = http.createServer(app);
server.on('upgrade', handleUpgrade);
server.listen(PORT, HOST, () => console.log(`CCTower 网关已启动:http://${HOST}:${PORT}`));

let shuttingDown = false;
function bye(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`网关收到 ${sig},关闭中`);
  hub.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => bye('SIGTERM'));
process.on('SIGINT', () => bye('SIGINT'));
