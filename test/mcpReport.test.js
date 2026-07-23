'use strict';
// MCP report_status server:JSON-RPC 握手、工具列表、调用转发到 HTTP API
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

function rpc(child, msg) {
  return new Promise((resolve) => {
    const onLine = (buf) => {
      for (const line of buf.toString().split('\n')) {
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        if (m.id === msg.id) { child.stdout.off('data', onLine); resolve(m); return; }
      }
    };
    child.stdout.on('data', onLine);
    child.stdin.write(JSON.stringify(msg) + '\n');
  });
}

test('mcpReport:握手、tools/list、tools/call 转发', async () => {
  const reports = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      reports.push({ url: req.url, body: JSON.parse(body) });
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  const child = spawn(process.execPath, [path.join(__dirname, '../server/mcpReport.js')], {
    env: { ...process.env, CCW_SESSION_ID: 'sid-1', CCW_BASE_URL: base },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const init = await rpc(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(init.result.serverInfo.name, 'cctower');
    assert.equal(init.result.protocolVersion, '2025-06-18');

    const list = await rpc(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(list.result.tools[0].name, 'report_status');
    assert.ok(list.result.tools[0].inputSchema.required.includes('objective'));

    const call = await rpc(child, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'report_status', arguments: { objective: '测试', phase: 'executing', next_action: '继续' } },
    });
    assert.match(call.result.content[0].text, /已上报/);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].url, '/api/report/sid-1');
    assert.equal(reports[0].body.objective, '测试');
  } finally {
    child.kill();
    srv.close();
  }
});
