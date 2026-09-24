'use strict';
// 前缀推导错一位,整个页面就会把请求打到网关根上,表现为"页面白屏但网关活着"。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { computePrefix } = require('../public/prefix.js');

test('直连本机:前缀为空串,行为与改造前一致', () => {
  assert.equal(computePrefix('/'), '');
  assert.equal(computePrefix('/index.html'), '');
});

test('网关下挂载:前缀是 /s/<id>', () => {
  assert.equal(computePrefix('/s/abc123/'), '/s/abc123');
  assert.equal(computePrefix('/s/abc123/index.html'), '/s/abc123');
});

test('多级前缀也能正确推导(将来放到子路径下也不怕)', () => {
  assert.equal(computePrefix('/a/b/'), '/a/b');
  assert.equal(computePrefix('/a/b/index.html'), '/a/b');
});

test('app.js 里不再有写死的绝对 API/WS 路径', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(!/fetch\('\/api\//.test(src), "不能再有 fetch('/api/...)");
  assert.ok(/CCW_PREFIX/.test(src), 'app.js 必须使用 CCW_PREFIX');
  // 光有 CCW_PREFIX 字样不够——必须校验 PREFIX 真的拼进了 api()/WS_BASE,
  // 否则删掉 "PREFIX + " 这种局部退化不会被上面两条断言捕获(变异测试实测漏检)。
  assert.ok(/fetch\(PREFIX \+ path/.test(src), "api() 必须用 fetch(PREFIX + path) 发起请求");
  assert.ok(/\$\{location\.host\}\$\{PREFIX\}/.test(src), 'WS_BASE 必须把 PREFIX 拼进 host 之后');
});

test('index.html 的资源引用全部是相对路径', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const abs = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(abs, [], `这些引用还是绝对路径:${abs.join(', ')}`);
  assert.match(html, /src="prefix\.js/, '必须在 app.js 之前加载 prefix.js');
});
