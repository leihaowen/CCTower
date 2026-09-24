'use strict';
// PermissionRequest hook 挂起请求:决定 JSON 形状、终端已处理时的释放、超时与断连清理
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { PermissionBroker } = require('../server/permissionBroker');

// 假 express res:记录回写内容,可模拟连接关闭
function fakeRes() {
  const res = new EventEmitter();
  res.body = undefined;
  res.status = (c) => { res.code = c; return res; };
  res.json = (b) => { res.body = b; res.writableEnded = true; res.emit('close'); return res; };
  res.end = () => { res.body = null; res.writableEnded = true; res.emit('close'); return res; };
  return res;
}

const bashPayload = {
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf node_modules', description: '删除依赖' },
  permission_suggestions: [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf node_modules' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ],
};
const askPayload = {
  tool_name: 'AskUserQuestion',
  tool_input: { questions: [
    { question: '用哪个框架?', header: '框架', options: [{ label: 'React' }, { label: 'Vue' }], multiSelect: false },
    { question: '要哪些功能?', header: '功能', options: [{ label: '登录' }, { label: '搜索' }], multiSelect: true },
  ] },
};

function newBroker(opts = {}) {
  const changes = [];
  const b = new PermissionBroker({ timeoutMs: 60_000, onChange: (sid) => changes.push(sid), ...opts });
  return { b, changes };
}

test('open 登记请求并按工具分类,list 只暴露公开字段', () => {
  const { b, changes } = newBroker();
  const r1 = b.open('s1', bashPayload, fakeRes());
  const r2 = b.open('s1', askPayload, fakeRes());
  const r3 = b.open('s1', { tool_name: 'ExitPlanMode', tool_input: { plan: '## 计划' } }, fakeRes());
  assert.equal(r1.kind, 'permission');
  assert.equal(r2.kind, 'question');
  assert.equal(r3.kind, 'plan');
  assert.equal(r1.summary, 'rm -rf node_modules');
  const list = b.list('s1');
  assert.equal(list.length, 3);
  assert.ok(!('res' in list[0]) && !('timer' in list[0]), '不应暴露内部字段');
  assert.deepEqual(b.list('other'), []);
  assert.deepEqual(changes, ['s1', 's1', 's1']);
  b.dispose();
});

test('批准:回写官方 allow 决定', () => {
  const { b } = newBroker();
  const res = fakeRes();
  const r = b.open('s1', bashPayload, res);
  b.resolve(r.id, { behavior: 'allow' });
  assert.deepEqual(res.body, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.deepEqual(b.list('s1'), []);
});

test('本会话总是允许:只取 addRules 建议,destination 强制为 session', () => {
  const { b } = newBroker();
  const res = fakeRes();
  const r = b.open('s1', bashPayload, res);
  b.resolve(r.id, { behavior: 'allow', always: true });
  const d = res.body.hookSpecificOutput.decision;
  assert.equal(d.behavior, 'allow');
  assert.deepEqual(d.updatedPermissions, [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf node_modules' }], behavior: 'allow', destination: 'session' },
  ]);
  assert.equal(bashPayload.permission_suggestions[0].destination, 'localSettings', '不应改动原始建议对象');
});

test('拒绝:带理由,不 interrupt', () => {
  const { b } = newBroker();
  const res = fakeRes();
  const r = b.open('s1', bashPayload, res);
  b.resolve(r.id, { behavior: 'deny', message: '别删依赖' });
  assert.deepEqual(res.body.hookSpecificOutput.decision, { behavior: 'deny', message: '别删依赖' });
});

test('拒绝不填理由时给默认说明', () => {
  const { b } = newBroker();
  const res = fakeRes();
  b.resolve(b.open('s1', bashPayload, res).id, { behavior: 'deny' });
  assert.ok(res.body.hookSpecificOutput.decision.message.length > 0);
});

test('回答问题:回显原输入并附 answers,多选以逗号连接', () => {
  const { b } = newBroker();
  const res = fakeRes();
  const r = b.open('s1', askPayload, res);
  b.resolve(r.id, { behavior: 'allow', answers: { '用哪个框架?': 'Vue', '要哪些功能?': ['登录', '搜索'] } });
  const d = res.body.hookSpecificOutput.decision;
  assert.equal(d.behavior, 'allow');
  assert.deepEqual(d.updatedInput.questions, askPayload.tool_input.questions);
  assert.deepEqual(d.updatedInput.answers, { '用哪个框架?': 'Vue', '要哪些功能?': '登录, 搜索' });
});

test('回答问题缺答案时拒绝提交', () => {
  const { b } = newBroker();
  const r = b.open('s1', askPayload, fakeRes());
  assert.throws(() => b.resolve(r.id, { behavior: 'allow', answers: { '用哪个框架?': 'Vue' } }), /要哪些功能/);
  assert.equal(b.list('s1').length, 1, '校验失败不应移除请求');
  b.dispose();
});

test('批准计划:回显原输入', () => {
  const { b } = newBroker();
  const res = fakeRes();
  const input = { plan: '## 计划', planFilePath: '/tmp/p.md' };
  b.resolve(b.open('s1', { tool_name: 'ExitPlanMode', tool_input: input }, res).id, { behavior: 'allow' });
  assert.deepEqual(res.body.hookSpecificOutput.decision, { behavior: 'allow', updatedInput: input });
});

test('resolve 未知请求抛错', () => {
  const { b } = newBroker();
  assert.throws(() => b.resolve('nope', { behavior: 'allow' }), /不存在/);
});

test('release 按工具+参数匹配释放,回空响应', () => {
  const { b } = newBroker();
  const resA = fakeRes();
  const resB = fakeRes();
  b.open('s1', bashPayload, resA);
  const rB = b.open('s1', { tool_name: 'Bash', tool_input: { command: 'ls' } }, resB);
  const out = b.release('s1', { toolName: 'Bash', input: { command: 'rm -rf node_modules', description: '删除依赖' } });
  assert.equal(out.length, 1);
  assert.equal(resA.body, null, '被释放的请求回空响应(=无决定)');
  assert.equal(resB.body, undefined, '其他请求不受影响');
  assert.deepEqual(b.list('s1').map((x) => x.id), [rB.id]);
  b.dispose();
});

test('release 参数不完全一致时,退而匹配该会话唯一的同名工具请求', () => {
  const { b } = newBroker();
  const res = fakeRes();
  b.open('s1', askPayload, res);
  // 终端作答后 PostToolUse 的 tool_input 可能带上 answers,与请求时不同
  const out = b.release('s1', { toolName: 'AskUserQuestion', input: { ...askPayload.tool_input, answers: { x: 'y' } } });
  assert.equal(out.length, 1);
  assert.equal(res.body, null);
});

test('release 同名工具有多个且参数都不匹配时不误释放', () => {
  const { b } = newBroker();
  b.open('s1', { tool_name: 'Bash', tool_input: { command: 'a' } }, fakeRes());
  b.open('s1', { tool_name: 'Bash', tool_input: { command: 'b' } }, fakeRes());
  assert.equal(b.release('s1', { toolName: 'Bash', input: { command: 'c' } }).length, 0);
  assert.equal(b.list('s1').length, 2);
  b.dispose();
});

test('release 不带 match 时释放该会话全部请求', () => {
  const { b } = newBroker();
  b.open('s1', bashPayload, fakeRes());
  b.open('s1', askPayload, fakeRes());
  b.open('s2', bashPayload, fakeRes());
  assert.equal(b.release('s1').length, 2);
  assert.equal(b.list('s2').length, 1);
  b.dispose();
});

test('超时:回空响应并移除', async () => {
  const released = [];
  const { b } = newBroker({ timeoutMs: 20, onRelease: (r, why) => released.push(why) });
  const res = fakeRes();
  b.open('s1', bashPayload, res);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(res.body, null);
  assert.deepEqual(b.list('s1'), []);
  assert.deepEqual(released, ['timeout']);
});

test('hook 连接先断开(如服务端之外的原因):移除请求,不再回写', () => {
  const released = [];
  const { b } = newBroker({ onRelease: (r, why) => released.push(why) });
  const res = fakeRes();
  b.open('s1', bashPayload, res);
  res.emit('close');
  assert.deepEqual(b.list('s1'), []);
  assert.deepEqual(released, ['disconnect']);
});

test('publicList 截断权限请求参数里的长字符串,提问保留原样,内部记录不受影响', () => {
  const { b } = newBroker();
  const big = 'x'.repeat(5000);
  b.open('s1', { tool_name: 'Write', tool_input: { file_path: '/a.txt', content: big } }, fakeRes());
  b.open('s1', askPayload, fakeRes());
  const [w, q] = b.publicList('s1');
  assert.ok(w.input.content.length < 2100);
  assert.match(w.input.content, /共 5000 字符/);
  assert.equal(w.input.file_path, '/a.txt');
  assert.deepEqual(q.input, askPayload.tool_input);
  assert.equal(b.list('s1')[0].input.content.length, 5000);
  b.dispose();
});
