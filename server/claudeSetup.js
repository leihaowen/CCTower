'use strict';
// Generates per-session Claude Code hook settings and the report_status protocol prompt.
const fs = require('fs');
const path = require('path');

function hookCommand(base, sessionId, event) {
  return `curl -s -m 3 -X POST '${base}/api/hook/${sessionId}/${event}' -H 'Content-Type: application/json' --data-binary @- >/dev/null 2>&1 || true`;
}

// Writes a settings JSON that makes Claude Code POST lifecycle events back to the workbench.
function writeHookSettings(dir, base, sessionId) {
  const events = ['Notification', 'Stop', 'SubagentStop', 'SessionEnd', 'UserPromptSubmit'];
  const hooks = {};
  for (const ev of events) {
    hooks[ev] = [{ hooks: [{ type: 'command', command: hookCommand(base, sessionId, ev) }] }];
  }
  const file = path.join(dir, `hooks-${sessionId}.json`);
  fs.writeFileSync(file, JSON.stringify({ hooks }, null, 2));
  return file;
}

// The "agent protocol" from PRD §7: the agent self-reports structured status via curl.
function protocolPrompt(base, sessionId) {
  const url = `${base}/api/report/${sessionId}`;
  return [
    'You are running inside Agent Workbench. Besides doing the task, you MUST report structured status so the user can supervise many sessions at once.',
    `Report by running this Bash command (replace the JSON):  curl -s -m 3 -X POST '${url}' -H 'Content-Type: application/json' -d '<JSON>'`,
    'JSON schema: {"objective": string, "phase": "executing"|"verifying"|"waiting"|"review", "progress": {"done": int, "total": int}, "completed": [string], "blocker": string|null, "decision": {"question": string, "options": [string], "recommended": string, "reason": string}|null, "next_action": string, "evidence": [string]}',
    'Report at these moments ONLY: (1) task start — objective + plan; (2) each phase completed; (3) when blocked or when a product/technical decision is needed from the user — fill "decision" with a concrete question and options, then STOP and wait for the user reply in this conversation; (4) when tests finish; (5) task end — deliverables + evidence + suggested next step.',
    'Write the JSON values in Chinese. Keep "next_action" actionable. Never invent progress you have not verified.',
  ].join('\n');
}

module.exports = { writeHookSettings, protocolPrompt };
