#!/usr/bin/env node
'use strict';
const readline = require('node:readline');
const { Store } = require('./src/store');
const { hashPassword } = require('./src/auth');

const MIN_PASSWORD = 8;

const USAGE = `用法:node gateway/cli.js <命令>

  add-server <名字>     添加一台服务器,打印接入 token(只显示这一次)
  list-servers          列出所有服务器
  remove-server <id>    删除服务器(等同吊销它的 token,在线隧道会被断开)
  set-password          设置网关登录密码`;

// 密码从 stdin 读,不走命令行参数——参数会留在 shell history 和 ps 输出里
function readPasswordFromStdin() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question('新密码:', (a) => { rl.close(); resolve(a); }));
}

async function run(argv, { store = new Store(), out = console.log, readPassword = readPasswordFromStdin } = {}) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'add-server': {
      const name = (rest[0] || '').trim();
      if (!name) { out('缺少名字。用法:add-server <名字>'); return 1; }
      const { server, token } = store.addServer(name);
      out(`已添加服务器 ${server.name}`);
      out(`  id:    ${server.id}`);
      out(`  token: ${token}`);
      out('');
      out('把它写进那台服务器的 /etc/cctower-agent.json(token 只显示这一次):');
      out(JSON.stringify({ gatewayUrl: 'wss://你的域名/tunnel', token, localPort: 7080 }, null, 2));
      return 0;
    }
    case 'list-servers': {
      const servers = store.listServers();
      if (!servers.length) { out('还没有添加任何服务器。用 add-server <名字> 添加。'); return 0; }
      for (const s of servers) out(`${s.id}  ${s.name}  最后在线:${s.lastSeenAt || '从未'}`);
      return 0;
    }
    case 'remove-server': {
      const id = (rest[0] || '').trim();
      if (!store.removeServer(id)) { out(`没有 id 为 ${id} 的服务器`); return 1; }
      out(`已删除 ${id},它的 token 立即失效`);
      out('');
      out('注意:该服务器的现有隧道会在网关下次心跳(最长约 30 秒)后自动断开。');
      out('若要立即断开,请重启网关进程。');
      return 0;
    }
    case 'set-password': {
      const pw = String(await readPassword() || '');
      if (pw.length < MIN_PASSWORD) { out(`密码至少 ${MIN_PASSWORD} 个字符`); return 1; }
      store.setConfig({ passwordHash: hashPassword(pw) });
      out('密码已更新,重启网关后生效');
      return 0;
    }
    default:
      out(USAGE);
      return 1;
  }
}

module.exports = { run };

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
