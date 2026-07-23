'use strict';
// Generates per-session Claude Code hook settings, MCP config, and the report_status protocol prompt.
const fs = require('fs');
const path = require('path');

function hookCommand(base, sessionId, event, token) {
  const auth = token ? ` -H 'X-CCW-Token: ${token}'` : '';
  return `curl -s -m 3 -X POST '${base}/api/hook/${sessionId}/${event}' -H 'Content-Type: application/json'${auth} --data-binary @- >/dev/null 2>&1 || true`;
}

// Writes a settings JSON that makes Claude Code POST lifecycle events back to the workbench,
// and pre-allows the CCTower MCP report tool so reporting never triggers a permission prompt.
function writeHookSettings(dir, base, sessionId, token) {
  const events = ['Notification', 'Stop', 'SubagentStop', 'SessionEnd', 'UserPromptSubmit'];
  const hooks = {};
  for (const ev of events) {
    hooks[ev] = [{ hooks: [{ type: 'command', command: hookCommand(base, sessionId, ev, token) }] }];
  }
  const settings = {
    hooks,
    permissions: { allow: ['mcp__cctower__report_status'] },
  };
  const file = path.join(dir, `hooks-${sessionId}.json`);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2), { mode: 0o600 }); // 可能含认证令牌,仅属主可读
  return file;
}

// Writes a per-session MCP config exposing the report_status tool (server/mcpReport.js).
function writeMcpConfig(dir, base, sessionId, token) {
  const file = path.join(dir, `mcp-${sessionId}.json`);
  const env = { CCW_SESSION_ID: sessionId, CCW_BASE_URL: base };
  if (token) env.CCW_TOKEN = token;
  fs.writeFileSync(file, JSON.stringify({
    mcpServers: {
      cctower: { command: process.execPath, args: [path.join(__dirname, 'mcpReport.js')], env },
    },
  }, null, 2), { mode: 0o600 }); // env 可能含认证令牌,仅属主可读
  return file;
}

// The "agent protocol" from PRD §7: the agent self-reports structured status.
function protocolPrompt(base, sessionId) {
  const url = `${base}/api/report/${sessionId}`;
  return [
    'You are running inside CCTower (a supervision tower for parallel Claude Code sessions). Besides doing the task, you MUST report structured status so the user can supervise many sessions at once.',
    'Report with the mcp__cctower__report_status tool (pre-approved, preferred). Only if that tool is unavailable, fall back to Bash:  curl -s -m 3 -X POST \'' + url + '\' -H \'Content-Type: application/json\' -H "X-CCW-Token: $CCW_TOKEN" -d \'<JSON matching the tool schema>\'',
    'Report at these moments ONLY: (1) task start — objective + plan; (2) each phase completed; (3) when blocked, or when a product/technical decision is needed from the user — fill "decision" with a concrete question and options, then STOP and wait for the user reply in this conversation; (4) when tests finish; (5) task end — deliverables + evidence + suggested next step.',
    'Write the field values in Chinese. Keep "next_action" actionable. Never invent progress you have not verified.',
  ].join('\n');
}

module.exports = { writeHookSettings, writeMcpConfig, protocolPrompt };
