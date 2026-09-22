'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const { db, settings, setSetting, audit } = require('../db');
const i18n = require('../i18n');
const { csrf, requireLogin, requireRole, ROLE_RANK, nowLocal, todayLocal, addDays, clean, isEmail } = require('../security');
const { catalog, createBooking, getBooking, sendMail, bookingEmailHtml } = require('../bookings');

const router = express.Router();
router.use((req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); res.set('Cache-Control', 'no-store'); next(); });
router.use(csrf);

const STATUSES = ['pending', 'confirmed', 'checked_in', 'collected', 'cancelled', 'no_show'];
const STATUS_LABEL = { pending: 'Pending', confirmed: 'Confirmed', checked_in: 'In storage', collected: 'Collected', cancelled: 'Cancelled', no_show: 'No show' };
const PAY = ['unpaid', 'paid', 'refunded'];
const METHODS = ['cash', 'card', 'online', 'invoice'];

router.use((req, res, next) => {
  const L = res.locals, s = settings();
  L.me = req.session.user || null;
  L.path = req.path;
  L.money = n => i18n.money(n, s, 'en');
  L.fmt = d => d ? i18n.fmtDate(d, 'en') : '—';
  L.icon = require('../admin-icons');
  L.STATUS_LABEL = STATUS_LABEL; L.STATUSES = STATUSES; L.PAY = PAY; L.METHODS = METHODS;
  L.can = role => !!(L.me && ROLE_RANK[L.me.role] >= ROLE_RANK[role]);
  L.flash = req.session.flash || null; delete req.session.flash;
  L.newEnquiries = L.me ? db.prepare("SELECT COUNT(*) n FROM enquiries WHERE status='new'").get().n : 0;
  next();
});
const flash = (req, type, msg) => { req.session.flash = { type, msg }; };
const view = (res, name, data) => res.render('admin/' + name, data);

// Staff linked to one location only see that location's bookings
function scope(req) {
  const u = req.session.user;
  return u && u.role === 'staff' && u.location_id ? { sql: ' AND b.location_id = ?', args: [u.location_id] } : { sql: '', args: [] };
}

// ---------------- Auth ----------------
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).render('admin/login', { error: 'Too many sign-in attempts. Wait 15 minutes and try again.', email: '' }) });

router.get('/login', (req, res) => req.session.user ? res.redirect('/admin') : view(res, 'login', { error: null, email: '' }));
router.post('/login', loginLimiter, (req, res) => {
  const email = clean(req.body.email, 200).toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email);
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) {
    audit(null, 'auth.fail', 'user', email);
    res.status(401); return view(res, 'login', { error: 'That email and password don\'t match an active account.', email });
  }
  const back = req.session.returnTo || '/admin';
  req.session.regenerate(err => {
    if (err) return res.redirect('/admin/login');
    req.session.user = { id: u.id, name: u.name, email: u.email, role: u.role, location_id: u.location_id };
    db.prepare("UPDATE users SET last_login=datetime('now') WHERE id=?").run(u.id);
    audit(req.session.user, 'auth.login', 'user', u.id);
    res.redirect(back.startsWith('/admin') ? back : '/admin');
  });
});
router.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/admin/login')));

router.use(requireLogin);
// Re-read the user each request so role changes and deactivation apply immediately
router.use((req, res, next) => {
  const u = db.prepare('SELECT id,name,email,role,location_id,active FROM users WHERE id=?').get(req.session.user.id);
  if (!u || !u.active) return req.session.destroy(() => res.redirect('/admin/login'));
  req.session.user = { id: u.id, name: u.name, email: u.email, role: u.role, location_id: u.location_id };
  res.locals.me = req.session.user;
  next();
});

// ---------------- Dashboard ----------------
router.get('/', (req, res) => {
  const today = todayLocal(), now = nowLocal(), month = today.slice(0, 7), sc = scope(req);
  const one = (sql, ...a) => db.prepare(sql).get(...a, ...sc.args);
  const kpi = {
    arrivals: one(`SELECT COUNT(*) n, COALESCE(SUM(bags),0) bags FROM bookings b WHERE substr(dropoff_at,1,10)=? AND status IN ('pending','confirmed')${sc.sql}`, today),
    stored: one(`SELECT COUNT(*) n, COALESCE(SUM(bags),0) bags FROM bookings b WHERE status='checked_in'${sc.sql}`),
    dueToday: one(`SELECT COUNT(*) n FROM bookings b WHERE status='checked_in' AND substr(pickup_at,1,10)=?${sc.sql}`, today),
    overdue: one(`SELECT COUNT(*) n FROM bookings b WHERE status='checked_in' AND pickup_at < ?${sc.sql}`, now),
    revenue: one(`SELECT COALESCE(SUM(total),0) v FROM bookings b WHERE payment_status='paid' AND substr(dropoff_at,1,7)=?${sc.sql}`, month),
    unpaid: one(`SELECT COALESCE(SUM(total),0) v FROM bookings b WHERE status IN ('pending','confirmed','checked_in','collected') AND payment_status='unpaid'${sc.sql}`),
    monthBookings: one(`SELECT COUNT(*) n FROM bookings b WHERE substr(created_at,1,7)=? AND status!='cancelled'${sc.sql}`, month),
  };
  const days = []; for (let i = -7; i <= 6; i++) days.push(addDays(today, i));
  const rows = db.prepare(`SELECT substr(dropoff_at,1,10) d, COUNT(*) n, SUM(bags) bags, SUM(total) v FROM bookings b
    WHERE substr(dropoff_at,1,10) BETWEEN ? AND ? AND status NOT IN ('cancelled')${sc.sql} GROUP BY d`).all(days[0], days[13], ...sc.args);
  const map = Object.fromEntries(rows.map(r => [r.d, r]));
  const series = days.map(d => ({ d, n: (map[d] || {}).n || 0, bags: (map[d] || {}).bags || 0, v: (map[d] || {}).v || 0, today: d === today }));
  const occupancy = db.prepare(`SELECT l.id, l.name_en, l.capacity,
      (SELECT COALESCE(SUM(bags),0) FROM bookings WHERE location_id=l.id AND status='checked_in') stored,
      (SELECT COUNT(*) FROM bookings WHERE location_id=l.id AND status IN ('pending','confirmed') AND substr(dropoff_at,1,10)=?) arriving
    FROM locations l WHERE l.active=1 ${sc.args.length ? 'AND l.id=?' : ''} ORDER BY l.sort`).all(today, ...sc.args);
  const upcoming = db.prepare(`SELECT b.*, l.name_en loc FROM bookings b LEFT JOIN locations l ON l.id=b.location_id
    WHERE status IN ('pending','confirmed') AND dropoff_at >= ?${sc.sql} ORDER BY dropoff_at LIMIT 8`).all(today, ...sc.args);
  const overdueList = db.prepare(`SELECT b.*, l.name_en loc FROM bookings b LEFT JOIN locations l ON l.id=b.location_id
    WHERE status='checked_in' AND pickup_at < ?${sc.sql} ORDER BY pickup_at LIMIT 8`).all(now, ...sc.args);
  view(res, 'dashboard', { title: 'Today', kpi, series, occupancy, upcoming, overdueList, today });
});

// ---------------- Bookings ----------------
function bookingQuery(req) {
  const q = req.query, where = ['1=1'], args = [];
  if (q.status && STATUSES.includes(q.status)) { where.push('b.status=?'); args.push(q.status); }
  if (q.active === '1') where.push("b.status IN ('pending','confirmed','checked_in')");
  if (q.pay && PAY.includes(q.pay)) { where.push('b.payment_status=?'); args.push(q.pay); }
  if (q.location) { where.push('b.location_id=?'); args.push(+q.location); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.from || '')) { where.push('substr(b.dropoff_at,1,10)>=?'); args.push(q.from); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.to || '')) { where.push('substr(b.dropoff_at,1,10)<=?'); args.push(q.to); }
  if (q.q) {
    const s = `%${clean(q.q, 80)}%`;
    where.push('(b.ref LIKE ? OR b.customer_name LIKE ? OR b.email LIKE ? OR b.phone LIKE ? OR b.tag_numbers LIKE ?)'); args.push(s, s, s, s, s);
  }
  const sc = scope(req);
  const sortMap = { drop: 'b.dropoff_at', created: 'b.created_at', total: 'b.total', pickup: 'b.pickup_at' };
  return { sql: `FROM bookings b LEFT JOIN locations l ON l.id=b.location_id LEFT JOIN tariffs t ON t.id=b.tariff_id WHERE ${where.join(' AND ')}${sc.sql}`,
    args: [...args, ...sc.args], order: `ORDER BY ${sortMap[q.sort] || 'b.dropoff_at'} ${q.dir === 'asc' ? 'ASC' : 'DESC'}` };
}

router.get('/bookings', (req, res) => {
  const bq = bookingQuery(req), per = 30, page = Math.max(1, +req.query.page || 1);
  const total = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(b.total),0) v, COALESCE(SUM(b.bags),0) bags ${bq.sql}`).get(...bq.args);
  const rows = db.prepare(`SELECT b.*, l.name_en loc, t.name_en plan ${bq.sql} ${bq.order} LIMIT ? OFFSET ?`).all(...bq.args, per, (page - 1) * per);
  const qs = new URLSearchParams(Object.entries(req.query).filter(([k, v]) => k !== 'page' && v)).toString();
  view(res, 'bookings', { title: 'Bookings', rows, total, page, pages: Math.max(1, Math.ceil(total.n / per)), q: req.query, qs, locations: catalog.locations(true) });
});

router.get('/bookings.csv', requireRole('manager'), (req, res) => {
  const bq = bookingQuery(req);
  const rows = db.prepare(`SELECT b.ref, b.status, b.payment_status, b.payment_method, b.source, b.customer_name, b.email, b.phone, l.name_en location, t.name_en plan,
      b.bags, b.days, b.dropoff_at, b.pickup_at, b.subtotal, b.discount, b.addons_total, b.total, b.currency, b.tag_numbers, b.checked_in_at, b.collected_at, b.created_at, b.lang
      ${bq.sql} ${bq.order}`).all(...bq.args);
  const cols = rows.length ? Object.keys(rows[0]) : ['ref'];
  // Quote cells and neutralise spreadsheet formula injection
  const cell = v => { let s = v == null ? '' : String(v); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = '\uFEFF' + [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\r\n');
  audit(req.session.user, 'bookings.export', 'booking', null, { count: rows.length });
  res.set('Content-Disposition', `attachment; filename="bookings-${todayLocal()}.csv"`).type('text/csv').send(csv);
});

function newForm(res, data) { view(res, 'booking-new', Object.assign({ title: 'New booking', locations: catalog.locations(), tariffs: catalog.tariffs(), addons: catalog.addons() }, data)); }
router.get('/bookings/new', (req, res) => {
  const now = nowLocal();
  newForm(res, { errors: {}, form: { date: now.slice(0, 10), time: now.slice(11, 16), bags: 1, days: 2, location_id: req.session.user.location_id || '', status: 'checked_in', source: 'walkin', lang: 'en' } });
});
router.post('/bookings', (req, res) => {
  const b = req.body;
  if (req.session.user.role === 'staff' && req.session.user.location_id) b.location_id = req.session.user.location_id;
  const status = ['confirmed', 'checked_in'].includes(b.status) ? b.status : 'confirmed';
  const lang = b.lang === 'tr' ? 'tr' : 'en';
  const r = createBooking(b, lang, { staff: true, user: req.session.user, status,
    source: ['walkin', 'phone', 'partner'].includes(b.source) ? b.source : 'walkin',
    payment_status: b.paid ? 'paid' : 'unpaid', payment_method: b.paid && METHODS.includes(b.payment_method) ? b.payment_method : null });
  if (!r.ok) { res.status(422); return newForm(res, { errors: r.errors, form: b }); }
  if (status === 'checked_in') db.prepare("UPDATE bookings SET checked_in_at=datetime('now'), tag_numbers=? WHERE id=?").run(clean(b.tag_numbers, 200), r.booking.id);
  if (b.send_email && r.booking.email) sendMail(r.booking.email, i18n.t(lang, 'email.subject', { ref: r.booking.ref }), bookingEmailHtml(r.booking));
  flash(req, 'ok', `Booking ${r.booking.ref} created.`);
  res.redirect(`/admin/bookings/${r.booking.id}`);
});

// QR scan target + quick lookup
router.get('/b/:ref', (req, res) => {
  const b = db.prepare('SELECT id FROM bookings WHERE ref=?').get(String(req.params.ref).toUpperCase());
  if (!b) { flash(req, 'err', `No booking ${req.params.ref}.`); return res.redirect('/admin/bookings'); }
  res.redirect(`/admin/bookings/${b.id}`);
});
router.get('/lookup', (req, res) => {
  const q = clean(req.query.q, 80).toUpperCase().replace(/^LP(?!-)/, 'LP-');
  const b = q && db.prepare('SELECT id FROM bookings WHERE ref=?').get(q);
  if (b) return res.redirect(`/admin/bookings/${b.id}`);
  res.redirect(`/admin/bookings?q=${encodeURIComponent(req.query.q || '')}`);
});

function loadBooking(req, res) {
  const b = getBooking(+req.params.id), u = req.session.user;
  if (!b || (u.role === 'staff' && u.location_id && b.location_id !== u.location_id)) {
    res.status(404); view(res, 'error', { title: 'Not found', message: 'That booking doesn\'t exist or belongs to another location.' });
    return null;
  }
  return b;
}
router.get('/bookings/:id', async (req, res, next) => {
  try {
    const b = loadBooking(req, res); if (!b) return;
    const base = settings().site_url.replace(/\/$/, '');
    const history = db.prepare("SELECT * FROM audit_log WHERE entity='booking' AND entity_id=? ORDER BY id DESC").all(b.ref);
    const qr = await QRCode.toString(`${base}/admin/b/${b.ref}`, { type: 'svg', margin: 0 });
    const customerLink = `${base}${i18n.url(b.lang || 'en', 'booking', b.ref)}?k=${b.token}`;
    const past = db.prepare('SELECT COUNT(*) n FROM bookings WHERE email=? AND id!=?').get(b.email, b.id).n;
    view(res, 'booking', { title: b.ref, b, history, qr, customerLink, past, locations: catalog.locations(true), now: nowLocal() });
  } catch (e) { next(e); }
});

router.post('/bookings/:id/status', (req, res) => {
  const b = loadBooking(req, res); if (!b) return;
  const to = req.body.status;
  if (!STATUSES.includes(to)) return res.redirect(`/admin/bookings/${b.id}`);
  const sets = ['status=?', "updated_at=datetime('now')"], args = [to];
  if (to === 'checked_in') { sets.push("checked_in_at=COALESCE(checked_in_at, datetime('now'))"); if (req.body.tag_numbers != null) { sets.push('tag_numbers=?'); args.push(clean(req.body.tag_numbers, 200)); } }
  if (to === 'collected') sets.push("collected_at=datetime('now')");
  if (req.body.mark_paid && METHODS.includes(req.body.payment_method)) { sets.push("payment_status='paid'", 'payment_method=?'); args.push(req.body.payment_method); }
  db.prepare(`UPDATE bookings SET ${sets.join(',')} WHERE id=?`).run(...args, b.id);
  audit(req.session.user, 'booking.status', 'booking', b.ref, { from: b.status, to, paid: !!req.body.mark_paid });
  flash(req, 'ok', `${b.ref}: ${STATUS_LABEL[to]}${req.body.mark_paid ? ' and paid' : ''}.`);
  res.redirect(req.body.back === 'dash' ? '/admin' : `/admin/bookings/${b.id}`);
});

router.post('/bookings/:id/payment', (req, res) => {
  const b = loadBooking(req, res); if (!b) return;
  const ps = PAY.includes(req.body.payment_status) ? req.body.payment_status : b.payment_status;
  if (ps === 'refunded' && !res.locals.can('manager')) { flash(req, 'err', 'Only managers can record refunds.'); return res.redirect(`/admin/bookings/${b.id}`); }
  const pm = METHODS.includes(req.body.payment_method) ? req.body.payment_method : null;
  db.prepare("UPDATE bookings SET payment_status=?, payment_method=?, updated_at=datetime('now') WHERE id=?").run(ps, ps === 'unpaid' ? null : pm, b.id);
  audit(req.session.user, 'booking.payment', 'booking', b.ref, { payment_status: ps, method: pm });
  flash(req, 'ok', 'Payment updated.');
  res.redirect(`/admin/bookings/${b.id}`);
});

router.post('/bookings/:id/notes', (req, res) => {
  const b = loadBooking(req, res); if (!b) return;
  db.prepare("UPDATE bookings SET notes_internal=?, tag_numbers=?, updated_at=datetime('now') WHERE id=?").run(clean(req.body.notes_internal, 2000), clean(req.body.tag_numbers, 200), b.id);
  audit(req.session.user, 'booking.notes', 'booking', b.ref);
  flash(req, 'ok', 'Notes saved.');
  res.redirect(`/admin/bookings/${b.id}`);
});

router.post('/bookings/:id/edit', requireRole('manager'), (req, res) => {
  const b = loadBooking(req, res); if (!b) return;
  const f = req.body, dt = s => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s || '') ? s.replace('T', ' ') : null;
  const drop = dt(f.dropoff_at) || b.dropoff_at, pick = dt(f.pickup_at) || b.pickup_at;
  if (pick <= drop) { flash(req, 'err', 'Collection must be after drop-off.'); return res.redirect(`/admin/bookings/${b.id}`); }
  if (f.email && !isEmail(f.email)) { flash(req, 'err', 'Enter a valid email.'); return res.redirect(`/admin/bookings/${b.id}`); }
  const total = parseFloat(f.total);
  db.prepare(`UPDATE bookings SET customer_name=?, email=?, phone=?, location_id=?, bags=?, dropoff_at=?, pickup_at=?, total=?, updated_at=datetime('now') WHERE id=?`)
    .run(clean(f.customer_name, 120) || b.customer_name, clean(f.email, 200).toLowerCase(), clean(f.phone, 40), +f.location_id || b.location_id,
      Math.max(1, Math.min(+f.bags || b.bags, 200)), drop, pick, isNaN(total) || total < 0 ? b.total : Math.round(total * 100) / 100, b.id);
  audit(req.session.user, 'booking.edit', 'booking', b.ref, { total: f.total, bags: f.bags, dropoff: drop, pickup: pick });
  flash(req, 'ok', 'Booking updated.');
  res.redirect(`/admin/bookings/${b.id}`);
});

router.post('/bookings/:id/resend', (req, res) => {
  const b = loadBooking(req, res); if (!b) return;
  sendMail(b.email, i18n.t(b.lang, 'email.subject', { ref: b.ref }), bookingEmailHtml(b));
  audit(req.session.user, 'booking.resend', 'booking', b.ref);
  flash(req, 'ok', `Confirmation re-sent to ${b.email}.`);
  res.redirect(`/admin/bookings/${b.id}`);
});

// ---------------- Generic bilingual CRUD ----------------
const TOWNS = ['Girne', 'Lefkoşa', 'Gazimağusa', 'İskele'];
const ENT = {
  locations: { title: 'Locations', single: 'location', key: 'slug', list: r => [r.name_en, r.town, r.open_24h ? '24h' : `${r.open_time}–${r.close_time}`, r.capacity + ' bags'], heads: ['Name', 'Town', 'Hours', 'Capacity'],
    fields: [
      { n: 'slug', l: 'URL slug', t: 'text', req: 1, hint: 'Lowercase with dashes. Changing it changes the page address (bad for SEO once live).' },
      { n: 'town', l: 'Town', t: 'select', opts: TOWNS, req: 1 },
      { n: 'name_en', l: 'Name (English)', t: 'text', req: 1 }, { n: 'name_tr', l: 'Name (Turkish)', t: 'text', req: 1 },
      { n: 'address_en', l: 'Address (English)', t: 'text' }, { n: 'address_tr', l: 'Address (Turkish)', t: 'text' },
      { n: 'desc_en', l: 'Description (English)', t: 'textarea' }, { n: 'desc_tr', l: 'Description (Turkish)', t: 'textarea' },
      { n: 'best_for_en', l: 'Best for (English)', t: 'text' }, { n: 'best_for_tr', l: 'Best for (Turkish)', t: 'text' },
      { n: 'lat', l: 'Latitude', t: 'number', step: 'any', hint: 'From Google Maps: right-click the spot' }, { n: 'lng', l: 'Longitude', t: 'number', step: 'any' },
      { n: 'open_time', l: 'Opens', t: 'time' }, { n: 'close_time', l: 'Closes', t: 'time' },
      { n: 'open_24h', l: 'Open 24 hours', t: 'check' }, { n: 'capacity', l: 'Capacity (bags)', t: 'number', req: 1, hint: 'Online bookings stop when this many bags are booked for overlapping times' },
      { n: 'phone', l: 'Direct phone', t: 'text' }, { n: 'step_free', l: 'Step-free access', t: 'check' },
      { n: 'sort', l: 'Sort order', t: 'number' }, { n: 'active', l: 'Visible and bookable', t: 'check' }] },
  tariffs: { title: 'Prices & plans', single: 'plan', key: 'code', list: r => [r.name_en, r.price, { per_bag: 'Per bag', per_bag_day: 'Per bag per day', flat: 'Flat monthly' }[r.mode], r.featured ? 'Highlighted' : ''], heads: ['Name', 'Price', 'Mode', ''], money: 1,
    fields: [
      { n: 'code', l: 'Code', t: 'text', req: 1, hint: 'Short id used in links, e.g. day' },
      { n: 'name_en', l: 'Name (English)', t: 'text', req: 1 }, { n: 'name_tr', l: 'Name (Turkish)', t: 'text', req: 1 },
      { n: 'desc_en', l: 'Tagline (English)', t: 'text' }, { n: 'desc_tr', l: 'Tagline (Turkish)', t: 'text' },
      { n: 'unit_en', l: 'Unit text (English)', t: 'text', hint: 'e.g. per bag, up to 24 hours' }, { n: 'unit_tr', l: 'Unit text (Turkish)', t: 'text' },
      { n: 'features_en', l: 'Features (English, one per line)', t: 'textarea' }, { n: 'features_tr', l: 'Features (Turkish, one per line)', t: 'textarea' },
      { n: 'mode', l: 'Pricing mode', t: 'select', opts: [['per_bag', 'Per bag, fixed duration'], ['per_bag_day', 'Per bag per day'], ['flat', 'Flat per month']], req: 1 },
      { n: 'price', l: 'Price', t: 'number', step: '0.01', req: 1 }, { n: 'hours', l: 'Duration in hours (per-bag mode)', t: 'number' },
      { n: 'min_days', l: 'Minimum days', t: 'number' }, { n: 'max_days', l: 'Maximum days', t: 'number' }, { n: 'max_bags', l: 'Maximum bags', t: 'number' },
      { n: 'featured', l: 'Highlight as "most booked"', t: 'check' }, { n: 'sort', l: 'Sort order', t: 'number' }, { n: 'active', l: 'Active', t: 'check' }] },
  addons: { title: 'Extras', single: 'extra', key: 'code', list: r => [r.name_en, r.price, r.per === 'bag' ? 'Per bag' : 'Per booking'], heads: ['Name', 'Price', 'Charged'], money: 1,
    fields: [
      { n: 'code', l: 'Code', t: 'text', req: 1 },
      { n: 'name_en', l: 'Name (English)', t: 'text', req: 1 }, { n: 'name_tr', l: 'Name (Turkish)', t: 'text', req: 1 },
      { n: 'desc_en', l: 'Description (English)', t: 'text' }, { n: 'desc_tr', l: 'Description (Turkish)', t: 'text' },
      { n: 'price', l: 'Price', t: 'number', step: '0.01', req: 1 },
      { n: 'per', l: 'Charged', t: 'select', opts: [['booking', 'Per booking'], ['bag', 'Per bag']] },
      { n: 'sort', l: 'Sort order', t: 'number' }, { n: 'active', l: 'Active', t: 'check' }] },
  faqs: { title: 'FAQs', single: 'question', key: 'id', list: r => [r.q_en, r.category, r.featured ? 'On homepage' : ''], heads: ['Question', 'Category', ''],
    fields: [
      { n: 'category', l: 'Category', t: 'select', opts: [['booking', 'Booking and payment'], ['bags', 'Your bags'], ['travel', 'Travel and hours'], ['students', 'Students'], ['general', 'General']] },
      { n: 'q_en', l: 'Question (English)', t: 'text', req: 1 }, { n: 'q_tr', l: 'Question (Turkish)', t: 'text', req: 1 },
      { n: 'a_en', l: 'Answer (English)', t: 'textarea', req: 1 }, { n: 'a_tr', l: 'Answer (Turkish)', t: 'textarea', req: 1 },
      { n: 'featured', l: 'Show on homepage', t: 'check' }, { n: 'sort', l: 'Sort order', t: 'number' }, { n: 'active', l: 'Active', t: 'check' }] },
};
const optVal = o => Array.isArray(o) ? o[0] : o;

router.get('/manage/:ent', requireRole('manager'), (req, res, next) => {
  const E = ENT[req.params.ent]; if (!E) return next();
  const rows = db.prepare(`SELECT * FROM ${req.params.ent} ORDER BY ${req.params.ent === 'faqs' ? 'category, sort' : 'sort'}, id`).all();
  view(res, 'crud-list', { title: E.title, E, ent: req.params.ent, rows });
});
router.get('/manage/:ent/:id', requireRole('manager'), (req, res, next) => {
  const E = ENT[req.params.ent]; if (!E) return next();
  const row = req.params.id === 'new' ? { active: 1, sort: 0 } : db.prepare(`SELECT * FROM ${req.params.ent} WHERE id=?`).get(+req.params.id);
  if (!row) return next();
  view(res, 'crud-form', { title: (row.id ? 'Edit ' : 'New ') + E.single, E, ent: req.params.ent, row, error: null });
});
router.post('/manage/:ent/:id', requireRole('manager'), (req, res, next) => {
  const E = ENT[req.params.ent]; if (!E) return next();
  const isNew = req.params.id === 'new', data = {}; let error = null;
  for (const f of E.fields) {
    let v = req.body[f.n];
    if (f.t === 'check') v = v ? 1 : 0;
    else if (f.t === 'number') { v = v === '' || v == null ? null : Number(v); if (v !== null && isNaN(v)) v = null; }
    else if (f.t === 'select') v = f.opts.map(optVal).includes(v) ? v : optVal(f.opts[0]);
    else v = clean(v, f.t === 'textarea' ? 4000 : 300);
    if (f.req && (v === '' || v == null)) error = error || `${f.l} is required.`;
    data[f.n] = v;
  }
  if (data.slug !== undefined) data.slug = String(data.slug).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  if (data.code !== undefined) data.code = String(data.code).toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  if (data.price != null && data.price < 0) error = 'Price can\'t be negative.';
  const redo = msg => { res.status(422); view(res, 'crud-form', { title: 'Check the form', E, ent: req.params.ent, row: Object.assign({ id: isNew ? null : +req.params.id }, data), error: msg }); };
  if (error) return redo(error);
  const cols = Object.keys(data);
  try {
    if (isNew) {
      const r = db.prepare(`INSERT INTO ${req.params.ent} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map(c => data[c]));
      audit(req.session.user, `${req.params.ent}.create`, req.params.ent, r.lastInsertRowid, data.name_en || data.q_en);
    } else {
      db.prepare(`UPDATE ${req.params.ent} SET ${cols.map(c => c + '=?').join(',')} WHERE id=?`).run(...cols.map(c => data[c]), +req.params.id);
      audit(req.session.user, `${req.params.ent}.update`, req.params.ent, req.params.id, data.name_en || data.q_en);
    }
  } catch (e) {
    return redo(/UNIQUE/.test(e.message) ? `That ${E.key} is already in use. Choose another.` : 'Couldn\'t save: ' + e.message);
  }
  flash(req, 'ok', `${E.single[0].toUpperCase() + E.single.slice(1)} saved. It's live on the site now.`);
  res.redirect(`/admin/manage/${req.params.ent}`);
});
router.post('/manage/:ent/:id/delete', requireRole('manager'), (req, res, next) => {
  const E = ENT[req.params.ent]; if (!E) return next();
  try {
    db.prepare(`DELETE FROM ${req.params.ent} WHERE id=?`).run(+req.params.id);
    audit(req.session.user, `${req.params.ent}.delete`, req.params.ent, req.params.id);
    flash(req, 'ok', 'Deleted.');
  } catch (e) {
    flash(req, 'err', /FOREIGN KEY/.test(e.message) ? 'Existing bookings use this, so it can\'t be deleted. Untick "Active" to hide it instead.' : e.message);
  }
  res.redirect(`/admin/manage/${req.params.ent}`);
});

// ---------------- Discounts ----------------
router.get('/discounts', requireRole('manager'), (req, res) => view(res, 'discounts', { title: 'Group discounts', tiers: db.prepare('SELECT * FROM discount_tiers ORDER BY min_bag_days').all() }));
router.post('/discounts', requireRole('manager'), (req, res) => {
  const mins = [].concat(req.body.min || []), pcts = [].concat(req.body.pct || []);
  const tiers = mins.map((m, i) => ({ m: parseInt(m, 10), p: parseFloat(pcts[i]) })).filter(x => x.m > 0 && x.p > 0 && x.p < 100);
  db.transaction(() => { db.prepare('DELETE FROM discount_tiers').run(); tiers.forEach(x => db.prepare('INSERT INTO discount_tiers (min_bag_days,percent) VALUES (?,?)').run(x.m, x.p)); })();
  audit(req.session.user, 'discounts.update', 'discount_tiers', null, tiers);
  flash(req, 'ok', 'Discounts saved. New bookings use them straight away.');
  res.redirect('/admin/discounts');
});

// ---------------- Enquiries ----------------
router.get('/enquiries', (req, res) => {
  const st = ['new', 'read', 'replied', 'archived'].includes(req.query.status) ? req.query.status : null;
  const rows = db.prepare(`SELECT * FROM enquiries ${st ? 'WHERE status=?' : "WHERE status!='archived'"} ORDER BY id DESC LIMIT 200`).all(...(st ? [st] : []));
  view(res, 'enquiries', { title: 'Enquiries', rows, st });
});
router.post('/enquiries/:id', (req, res) => {
  const s = ['new', 'read', 'replied', 'archived'].includes(req.body.status) ? req.body.status : 'read';
  db.prepare('UPDATE enquiries SET status=? WHERE id=?').run(s, +req.params.id);
  audit(req.session.user, 'enquiry.status', 'enquiry', req.params.id, s);
  res.redirect('/admin/enquiries' + (req.body.back ? '?status=' + encodeURIComponent(req.body.back) : ''));
});

// ---------------- Site text ----------------
router.get('/content', requireRole('manager'), (req, res) => {
  const q = clean(req.query.q, 60).toLowerCase(), g = clean(req.query.g, 30);
  const ov = Object.fromEntries(db.prepare('SELECT * FROM content').all().map(r => [r.key, r]));
  const all = Object.keys(i18n.dict.en);
  const groups = [...new Set(all.map(k => k.split('.')[0]))];
  const keys = all.filter(k => q ? (k.toLowerCase().includes(q) || i18n.dict.en[k].toLowerCase().includes(q) || (i18n.dict.tr[k] || '').toLowerCase().includes(q)) : k.split('.')[0] === (g || 'home'));
  view(res, 'content', { title: 'Site text', keys, groups, ov, q, g: g || (q ? '' : 'home'), dict: i18n.dict });
});
router.post('/content', requireRole('manager'), (req, res) => {
  const key = String(req.body.key || '');
  if (!(key in i18n.dict.en)) return res.redirect('/admin/content');
  const en = clean(req.body.en, 4000), tr = clean(req.body.tr, 4000);
  if (req.body.reset) db.prepare('DELETE FROM content WHERE key=?').run(key);
  else db.prepare("INSERT OR REPLACE INTO content (key,en,tr,updated_at) VALUES (?,?,?,datetime('now'))")
    .run(key, en && en !== i18n.dict.en[key] ? en : null, tr && tr !== i18n.dict.tr[key] ? tr : null);
  i18n.invalidate();
  audit(req.session.user, req.body.reset ? 'content.reset' : 'content.update', 'content', key);
  flash(req, 'ok', req.body.reset ? `“${key}” reset to the original text.` : `“${key}” saved. It's live now.`);
  res.redirect(`/admin/content?g=${encodeURIComponent(key.split('.')[0])}#k-${key.replace(/\./g, '-')}`);
});

// ---------------- Settings ----------------
const SETTINGS = [
  ['business_name', 'Business name'], ['site_url', 'Public site address', 'Used in emails, the sitemap and QR codes, e.g. https://luggagepark.com'],
  ['currency', 'Currency code', 'EUR, GBP or TRY'], ['currency_symbol', 'Currency symbol', '€, £ or ₺'],
  ['phone', 'Phone (shown on site)'], ['whatsapp', 'WhatsApp number', 'Digits only with country code, e.g. 905481234567'],
  ['email', 'Public email', 'Contact-form enquiries are also sent here'], ['booking_notice_email', 'Send new-booking alerts to', 'Leave empty to turn off'],
  ['maintenance_banner_en', 'Site banner (English)', 'Shown at the top of every page. Leave empty to hide.'], ['maintenance_banner_tr', 'Site banner (Turkish)'],
];
router.get('/settings', requireRole('owner'), (req, res) => view(res, 'settings', { title: 'Settings', SETTINGS, s: settings(), mailOn: !!process.env.SMTP_HOST }));
router.post('/settings', requireRole('owner'), (req, res) => {
  for (const [k] of SETTINGS) if (req.body[k] !== undefined) setSetting(k, clean(req.body[k], 300));
  audit(req.session.user, 'settings.update', 'settings');
  flash(req, 'ok', 'Settings saved.');
  res.redirect('/admin/settings');
});

router.get('/backup', requireRole('owner'), async (req, res, next) => {
  try {
    const file = require('path').join(require('os').tmpdir(), `luggagepark-${Date.now()}.db`);
    await db.backup(file);
    audit(req.session.user, 'backup.download', 'settings');
    res.download(file, `luggagepark-backup-${todayLocal()}.db`, () => require('fs').unlink(file, () => {}));
  } catch (e) { next(e); }
});

// ---------------- Team ----------------
const teamRows = () => db.prepare('SELECT u.*, l.name_en loc FROM users u LEFT JOIN locations l ON l.id=u.location_id ORDER BY u.active DESC, u.name').all();
router.get('/users', requireRole('owner'), (req, res) => view(res, 'users', { title: 'Team', rows: teamRows(), locations: catalog.locations(true), error: null, form: {} }));
router.post('/users', requireRole('owner'), (req, res) => {
  const email = clean(req.body.email, 200).toLowerCase(), name = clean(req.body.name, 120), pw = String(req.body.password || '');
  const role = ['staff', 'manager', 'owner'].includes(req.body.role) ? req.body.role : 'staff';
  let error = null;
  if (!name || !isEmail(email)) error = 'Enter a name and a valid email.';
  else if (pw.length < 10) error = 'Password must be at least 10 characters.';
  else if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) error = 'That email already has an account.';
  if (error) { res.status(422); return view(res, 'users', { title: 'Team', rows: teamRows(), locations: catalog.locations(true), error, form: req.body }); }
  const r = db.prepare('INSERT INTO users (email,name,password_hash,role,location_id) VALUES (?,?,?,?,?)').run(email, name, bcrypt.hashSync(pw, 12), role, +req.body.location_id || null);
  audit(req.session.user, 'user.create', 'user', r.lastInsertRowid, { email, role });
  flash(req, 'ok', `${name} can now sign in at /admin with the password you set.`);
  res.redirect('/admin/users');
});
router.post('/users/:id', requireRole('owner'), (req, res) => {
  const id = +req.params.id, u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.redirect('/admin/users');
  const owners = db.prepare("SELECT COUNT(*) n FROM users WHERE role='owner' AND active=1").get().n;
  const role = ['staff', 'manager', 'owner'].includes(req.body.role) ? req.body.role : u.role;
  const active = req.body.active ? 1 : 0;
  if (u.role === 'owner' && u.active && (role !== 'owner' || !active) && owners <= 1) {
    flash(req, 'err', 'You need at least one active owner. Make someone else an owner first.'); return res.redirect('/admin/users');
  }
  if (req.body.password && String(req.body.password).length < 10) { flash(req, 'err', 'Password must be at least 10 characters.'); return res.redirect('/admin/users'); }
  db.prepare('UPDATE users SET role=?, active=?, location_id=? WHERE id=?').run(role, active, +req.body.location_id || null, id);
  if (req.body.password) db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(String(req.body.password), 12), id);
  audit(req.session.user, 'user.update', 'user', id, { role, active, password_reset: !!req.body.password });
  flash(req, 'ok', `${u.name} updated.`);
  res.redirect('/admin/users');
});

router.get('/account', (req, res) => view(res, 'account', { title: 'Your account', error: null }));
router.post('/account', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.user.id);
  const nw = String(req.body.new_password || '');
  let error = null;
  if (!bcrypt.compareSync(String(req.body.current_password || ''), u.password_hash)) error = 'Your current password is incorrect.';
  else if (nw.length < 10) error = 'New password must be at least 10 characters.';
  else if (nw !== req.body.confirm_password) error = 'The two new passwords don\'t match.';
  if (error) { res.status(422); return view(res, 'account', { title: 'Your account', error }); }
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(nw, 12), u.id);
  audit(req.session.user, 'user.password', 'user', u.id);
  flash(req, 'ok', 'Password changed.');
  res.redirect('/admin/account');
});

// ---------------- Activity log ----------------
router.get('/audit', requireRole('manager'), (req, res) => {
  const page = Math.max(1, +req.query.page || 1);
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100 OFFSET ?').all((page - 1) * 100);
  view(res, 'audit', { title: 'Activity log', rows, page });
});

router.use((req, res) => { res.status(404); view(res, 'error', { title: 'Not found', message: 'That admin page doesn\'t exist.' }); });

module.exports = router;
