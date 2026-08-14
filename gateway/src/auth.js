'use strict';
const crypto = require('node:crypto');

const SESSION_COOKIE = 'ccgw_session';
const SESSION_TTL_SEC = 7 * 24 * 3600;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 32;

// 同步 scrypt 会阻塞事件循环 50–100ms。登录是低频操作,这点耗时反而是对暴力破解的阻尼。
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEY_LEN, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let salt, expect;
  try {
    salt = Buffer.from(parts[1], 'base64');
    expect = Buffer.from(parts[2], 'base64');
  } catch { return false; }
  if (salt.length === 0 || expect.length !== KEY_LEN) return false;
  const got = crypto.scryptSync(String(password), salt, KEY_LEN, SCRYPT);
  return crypto.timingSafeEqual(got, expect);
}

function signSession(secret, expSec) {
  const payload = Buffer.from(JSON.stringify({ exp: expSec }), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySession(secret, token, nowSec = Math.floor(Date.now() / 1000)) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expect = crypto.createHmac('sha256', secret).update(parts[0]).digest('base64url');
  const a = Buffer.from(parts[1], 'utf8');
  const b = Buffer.from(expect, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let obj;
  try { obj = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return null; }
  if (!obj || typeof obj.exp !== 'number' || obj.exp <= nowSec) return null;
  return obj;
}

// secure=false 只给本地 http 调试用:浏览器不会存 http 页面下带 Secure 的 cookie
function buildCookie(value, { maxAgeSec = SESSION_TTL_SEC, secure = true } = {}) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=${maxAgeSec}`;
}
function clearCookie({ secure = true } = {}) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=0`;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); }
    catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

// 计所有尝试(不只是失败):成功后调用 reset,正常用户感知不到,暴力破解者一直撞墙
class RateLimiter {
  constructor({ limit = 5, windowMs = 60_000, now = Date.now } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }
  allow(key) {
    const t = this.now();
    const arr = (this.hits.get(key) || []).filter((ts) => t - ts < this.windowMs);
    if (arr.length >= this.limit) { this.hits.set(key, arr); return false; }
    arr.push(t);
    this.hits.set(key, arr);
    return true;
  }
  reset(key) { this.hits.delete(key); }
}

module.exports = {
  hashPassword, verifyPassword, signSession, verifySession,
  buildCookie, clearCookie, parseCookies, RateLimiter,
  SESSION_COOKIE, SESSION_TTL_SEC,
};
