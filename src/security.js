'use strict';
const crypto = require('crypto');
const session = require('express-session');
const { db } = require('./db');
const { TZ } = require('./i18n');

// ---- SQLite session store ----
class SqliteStore extends session.Store {
  constructor() {
    super();
    this.getQ = db.prepare('SELECT sess, expires FROM sessions WHERE sid=?');
    this.setQ = db.prepare('INSERT OR REPLACE INTO sessions (sid,sess,expires) VALUES (?,?,?)');
    this.delQ = db.prepare('DELETE FROM sessions WHERE sid=?');
    setInterval(() => db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()), 3600e3).unref();
  }
  get(sid, cb) {
    try {
      const r = this.getQ.get(sid);
      if (!r || r.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(r.sess));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const exp = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 864e5;
      this.setQ.run(sid, JSON.stringify(sess), exp); cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) { try { this.delQ.run(sid); cb && cb(null); } catch (e) { cb && cb(e); } }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

// ---- CSRF (synchronizer token in session) ----
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const tok = (req.body && req.body._csrf) || req.get('x-csrf-token');
    if (!tok || tok.length !== req.session.csrf.length ||
      !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(req.session.csrf))) {
      return res.status(403).send('Security token expired. Go back, refresh the page and try again.');
    }
  }
  next();
}

// ---- Roles ----
const ROLE_RANK = { staff: 1, manager: 2, owner: 3 };
function requireLogin(req, res, next) {
  if (req.session.user) return next();
  req.session.returnTo = req.originalUrl;
  res.redirect('/admin/login');
}
function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/admin/login');
    if (ROLE_RANK[req.session.user.role] >= ROLE_RANK[role]) return next();
    res.status(403).render('admin/error', { title: 'No access', message: 'Your role doesn\'t have access to this section. Ask the owner if you need it.' });
  };
}

// ---- Time (all booking times are stored as North Cyprus wall-clock "YYYY-MM-DD HH:MM") ----
function nowLocal() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
function todayLocal() { return nowLocal().slice(0, 10); }
function addHours(local, h) {
  const d = new Date(local.replace(' ', 'T') + ':00Z');
  d.setUTCMinutes(d.getUTCMinutes() + Math.round(h * 60));
  return d.toISOString().slice(0, 16).replace('T', ' ');
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function makeRef() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (const b of crypto.randomBytes(6)) s += A[b % A.length];
  return `LP-${s.slice(0, 3)}${s.slice(3)}`;
}
const token = () => crypto.randomBytes(18).toString('base64url');
const isEmail = e => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(String(e || ''));
const clean = (s, max = 500) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);

module.exports = { SqliteStore, csrf, requireLogin, requireRole, ROLE_RANK, nowLocal, todayLocal, addHours, addDays, makeRef, token, isEmail, clean };
