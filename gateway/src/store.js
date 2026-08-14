'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_CONFIG = { port: 7081, passwordHash: '', sessionSecret: '' };

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}
function newToken() { return crypto.randomBytes(32).toString('base64url'); }
function newId() { return crypto.randomBytes(6).toString('hex'); }

function defaultDir() {
  return process.env.CCTOWER_GATEWAY_DATA || path.join(os.homedir(), '.cctower-gateway');
}

class Store {
  constructor(dir = defaultDir()) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // 目录已存在时 mode 被忽略,需主动修正权限(不属于自己的目录权限修正失败可接受)
    try { fs.chmodSync(dir, 0o700); } catch (e) {
      if (e.code !== 'EPERM') throw e;
    }
    this.serversFile = path.join(dir, 'servers.json');
    this.configFile = path.join(dir, 'config.json');
  }

  // 坏文件不能让网关起不来:此刻能连上的隧道比历史记录更重要
  _read(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }
  // 先写临时文件再 rename:断电/并发也不会留下半截 JSON
  // 并发写会互相踩踏,所以临时文件名必须唯一(pid + 随机后缀)
  _write(file, data) {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      // 临时文件预置 0644 时会被最终文件继承,写完后显式收紧权限
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, file);
    } catch (e) {
      // rename 失败时清理掉自己的临时文件(防止后续读到半截内容)
      try { fs.unlinkSync(tmp); } catch { }
      throw e;
    }
  }

  listServers() {
    const v = this._read(this.serversFile, []);
    return Array.isArray(v) ? v : [];
  }

  addServer(name) {
    const servers = this.listServers();
    const token = newToken();
    const server = {
      id: newId(),
      name: String(name || '').trim() || '未命名服务器',
      tokenHash: tokenHash(token),
      addedAt: new Date().toISOString(),
      lastSeenAt: null,
    };
    servers.push(server);
    this._write(this.serversFile, servers);
    return { server, token };
  }

  removeServer(id) {
    const servers = this.listServers();
    const next = servers.filter((s) => s.id !== id);
    if (next.length === servers.length) return false;
    this._write(this.serversFile, next);
    return true;
  }

  findByToken(token) {
    const t = String(token || '');
    if (!t) return null;
    const want = Buffer.from(tokenHash(t), 'utf8');
    for (const s of this.listServers()) {
      const got = Buffer.from(String(s.tokenHash || ''), 'utf8');
      if (got.length === want.length && crypto.timingSafeEqual(got, want)) return s;
    }
    return null;
  }

  touch(id) {
    const servers = this.listServers();
    const s = servers.find((x) => x.id === id);
    if (!s) return;
    s.lastSeenAt = new Date().toISOString();
    this._write(this.serversFile, servers);
  }

  getConfig() {
    const v = this._read(this.configFile, {});
    return { ...DEFAULT_CONFIG, ...(v && typeof v === 'object' ? v : {}) };
  }

  setConfig(patch) {
    const next = { ...this.getConfig(), ...(patch || {}) };
    this._write(this.configFile, next);
    return next;
  }

  // 会话密钥必须跨重启稳定,否则网关一重启所有人都被登出
  // 并发首次调用时各进程生成各自的 secret,但要返回磁盘上的最终值(幂等)
  // setConfig 与随后的 getConfig 之间若另一进程覆盖 config.json,
  // 重新读盘可能拿到空 sessionSecret,此时必须再写一次保证非空
  ensureSecret() {
    const cfg = this.getConfig();
    if (cfg.sessionSecret) return cfg.sessionSecret;
    const secret = crypto.randomBytes(32).toString('base64');
    this.setConfig({ sessionSecret: secret });
    // 写盘后重新读一次,返回磁盘上的最终值(在并发下可能被其他进程覆盖了)
    const reread = this.getConfig().sessionSecret;
    if (reread) return reread;
    // 若磁盘上的值为空(被其他进程覆盖了),再写一次自己的 secret
    this.setConfig({ sessionSecret: secret });
    return secret;
  }
}

module.exports = { Store, tokenHash, newToken };
