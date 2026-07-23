#!/usr/bin/env node
'use strict';
// CCTower 本地 MCP server(stdio):向 agent 暴露 report_status 工具,
// 调用即转发到 CCTower 的 /api/report/<session>。零依赖,newline-delimited JSON-RPC。
const readline = require('readline');

const SID = process.env.CCW_SESSION_ID || '';
const BASE = process.env.CCW_BASE_URL || '';

const TOOL = {
  name: 'report_status',
  description: '向 CCTower 工作台上报当前会话的结构化工作状态。在任务开始、每个阶段完成、遇到阻塞、需要用户决策、测试结束、任务结束时调用。需要用户决策时填写 decision 并在本轮停下等待用户回复。',
  inputSchema: {
    type: 'object',
    properties: {
      objective: { type: 'string', description: '用户目标,一句话' },
      phase: { type: 'string', enum: ['executing', 'verifying', 'waiting', 'review'] },
      progress: {
        type: 'object',
        properties: { done: { type: 'integer' }, total: { type: 'integer' } },
      },
      completed: { type: 'array', items: { type: 'string' }, description: '已完成事项' },
      blocker: { type: 'string', description: '阻塞原因,没有则省略' },
      decision: {
        type: 'object',
        description: '需要用户做的决策,没有则省略',
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          recommended: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['question'],
      },
      next_action: { type: 'string', description: '下一步,可执行的一句话' },
      evidence: { type: 'array', items: { type: 'string' }, description: '测试/文件/PR 等证据' },
    },
    required: ['objective', 'phase', 'next_action'],
  },
};

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'cctower', version: '1.0.0' },
      },
    });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [TOOL] } });
  } else if (method === 'tools/call') {
    let text;
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (process.env.CCW_TOKEN) headers['X-CCW-Token'] = process.env.CCW_TOKEN;
      const r = await fetch(`${BASE}/api/report/${SID}`, {
        method: 'POST',
        headers,
        body: JSON.stringify((params && params.arguments) || {}),
      });
      const j = await r.json();
      text = j.ok ? '状态已上报 CCTower' : '上报被拒绝(session 不存在或类型不符)';
    } catch (e) {
      text = '上报失败:' + e.message;
    }
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
  } else if (id !== undefined) {
    // 其余请求(ping 等)一律成功空响应,通知(无 id)忽略
    send({ jsonrpc: '2.0', id, result: {} });
  }
});
