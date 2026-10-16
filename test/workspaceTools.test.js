'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { workspaceTools } = require('../server/workspaceTools');

test('file transfer: binary roundtrip, authentication, path confinement, no overwrite, scoped tickets', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccw-files-'));
  const sessions = [{ id: 'source', cwd: root, name: 'Project' }];
  let creates = 0, restarts = 0;
  const manager = {
    get: (id) => sessions.find((s) => s.id === id), list: () => sessions,
    createSession: (opts) => { creates++; const s = { id: 'quick', cwd: opts.projectDir, alive: true }; sessions.push(s); return s; },
    restart: (id) => { restarts++; manager.get(id).alive = true; }, _touch() {},
  };
  const app = express(); app.use(express.json());
  const tools = workspaceTools(manager);
  app.use('/api', (req, res, next) => req.headers['x-ccw-token'] === 'secret' || tools.authorizeDownload(req) ? next() : res.sendStatus(401));
  tools.mount(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/api/sessions/source`;
  const request = (suffix, opts = {}) => fetch(base + suffix, { ...opts, headers: { 'x-ccw-token': 'secret', ...opts.headers } });
  assert.equal((await fetch(base + '/files')).status, 401);
  const bytes = Buffer.from([0, 255, 1, 13, 10, 128]);
  const upload = () => request('/files?name=%E6%B5%8B%E8%AF%95.bin', { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes });
  assert.equal((await upload()).status, 200);
  assert.equal((await upload()).status, 409);
  assert.deepEqual(await fs.readFile(path.join(root, '测试.bin')), bytes);
  assert.equal((await request('/files?path=..')).status, 403);
  await fs.symlink(os.tmpdir(), path.join(root, 'escape'));
  assert.equal((await request('/files?path=escape')).status, 403);
  assert.equal((await request('/files?name=..%2Fevil', { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes })).status, 400);
  const listing = await (await request('/files')).json();
  assert.equal(listing.parent, null);
  assert.deepEqual(listing.files.map((f) => f.name), ['测试.bin']);
  const ticket = await (await request('/files/ticket', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '测试.bin' }) })).json();
  const download = await fetch(`http://127.0.0.1:${server.address().port}${ticket.url}`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /attachment/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  assert.equal((await fetch(base + '/files?' + ticket.url.split('?')[1])).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}${ticket.url.replace('/source/', '/other/')}`)).status, 401);
  await t.test('downloads dotfiles and files inside hidden directories after authorization', async () => {
    await fs.mkdir(path.join(root, '.config'));
    for (const file of ['.env', '.config/settings.json']) {
      const fixture = 'synthetic download fixture\n';
      await fs.writeFile(path.join(root, file), fixture);
      const result = await request('/files/ticket', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: file }) });
      assert.equal(result.status, 200);
      const { url } = await result.json();
      const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`);
      assert.equal(response.status, 200, file);
      assert.match(response.headers.get('content-disposition'), /attachment/);
      assert.equal(await response.text(), fixture);
      assert.equal((await fetch(base + '/files/download')).status, 401);
    }
  });
  const quick = () => request('/quick-terminal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await (await quick()).json()).cwd, root);
  await quick(); assert.equal(creates, 1);
  sessions[1].alive = false; await quick(); assert.equal(restarts, 1); assert.equal(creates, 1);
  assert.ok(!(await fs.readdir(root)).some((f) => f.startsWith('.ccw-upload-')));
});
