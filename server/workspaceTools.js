'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const LIMIT = 256 * 1024 * 1024;

function workspaceTools(manager) {
  const tickets = new Map();
  const error = (message, status = 400) => Object.assign(new Error(message), { status });
  async function resolve(id, relative = '.') {
    const s = manager.get(id);
    if (!s) throw error('会话不存在', 404);
    const root = await fsp.realpath(s.cwd);
    const real = await fsp.realpath(path.resolve(root, String(relative)));
    if (real !== root && !real.startsWith(root + path.sep)) throw error('路径超出会话目录', 403);
    return { root, real };
  }
  function authorizeDownload(req) {
    const ticket = tickets.get(req.query.ticket);
    return !!ticket && ticket.expires > Date.now() &&
      req.method === 'GET' && req.originalUrl.split('?')[0] === `/api/sessions/${ticket.id}/files/download`;
  }
  function mount(app) {
    const route = (fn) => async (req, res) => {
      try { await fn(req, res); }
      catch (e) { if (!res.headersSent && !res.destroyed) res.status(e.status || (e.code === 'EEXIST' ? 409 : 400)).json({ error: e.code === 'EEXIST' ? '同名文件已存在，请重命名后上传' : e.message }); }
    };
    app.get('/api/sessions/:id/files', route(async (req, res) => {
      const { root, real } = await resolve(req.params.id, req.query.path);
      const entries = await fsp.readdir(real, { withFileTypes: true });
      const files = await Promise.all(entries.map(async (e) => {
        try {
          const target = await resolve(req.params.id, path.join(real, e.name));
          const stat = await fsp.stat(target.real);
          if (!stat.isFile() && !stat.isDirectory()) return null;
          return { name: e.name, directory: stat.isDirectory(), size: stat.size };
        } catch { return null; }
      }));
      res.json({ root, path: path.relative(root, real) || '.', parent: real === root ? null : path.relative(root, path.dirname(real)) || '.', files: files.filter(Boolean).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)) });
    }));
    app.put('/api/sessions/:id/files', route(async (req, res) => {
      if (!req.is('application/octet-stream')) throw error('请使用二进制文件上传');
      const { real } = await resolve(req.params.id, req.query.path);
      const name = String(req.query.name || '');
      if (!name || name === '.' || name === '..' || /[/\\\x00-\x1f]/.test(name)) throw error('文件名无效');
      const target = path.join(real, name);
      const tmp = path.join(real, `.ccw-upload-${crypto.randomBytes(12).toString('hex')}`);
      let size = 0;
      const cap = new Transform({ transform(chunk, enc, cb) { size += chunk.length; cb(size > LIMIT ? error('单个文件不能超过 256 MB', 413) : null, chunk); } });
      try {
        await pipeline(req, cap, fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
        // link is atomic and never overwrites existing files (including symlinks).
        await fsp.link(tmp, target);
        res.json({ ok: true, name, size });
      } finally { await fsp.unlink(tmp).catch(() => {}); }
    }));
    app.post('/api/sessions/:id/files/ticket', route(async (req, res) => {
      const { real } = await resolve(req.params.id, req.body.path);
      if (!(await fsp.stat(real)).isFile()) throw error('只能下载普通文件');
      for (const [key, item] of tickets) if (item.expires < Date.now()) tickets.delete(key);
      if (tickets.size >= 1000) tickets.delete(tickets.keys().next().value);
      const ticket = crypto.randomBytes(24).toString('hex');
      tickets.set(ticket, { id: req.params.id, file: real, expires: Date.now() + 120000 });
      res.json({ url: `/api/sessions/${req.params.id}/files/download?ticket=${ticket}` });
    }));
    app.get('/api/sessions/:id/files/download', route(async (req, res) => {
      if (!authorizeDownload(req)) throw error('下载链接已过期，请重新下载', 403);
      const t = tickets.get(req.query.ticket);
      const { real } = await resolve(t.id, t.file);
      if (!(await fsp.stat(real)).isFile()) throw error('只能下载普通文件');
      res.set('Cache-Control', 'no-store');
      res.download(real, path.basename(real));
    }));
    app.post('/api/sessions/:id/quick-terminal', route(async (req, res) => {
      const source = manager.get(req.params.id);
      if (!source) throw error('会话不存在', 404);
      let terminal = manager.list().find((s) => s.quickFor === source.id && !s.archived);
      if (!terminal) {
        terminal = manager.createSession({ type: 'terminal', name: `快捷终端 · ${source.name}`, projectDir: source.cwd, isolate: false });
        terminal.quickFor = source.id;
        manager._touch(terminal);
      } else if (!terminal.alive) manager.restart(terminal.id);
      res.json({ id: terminal.id, cwd: terminal.cwd });
    }));
  }
  return { mount, authorizeDownload, resolve };
}
module.exports = { workspaceTools };
