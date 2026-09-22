'use strict';
const { db, settings, audit } = require('./db');
const P = require('../public/js/pricing');
const { nowLocal, addHours, makeRef, token, isEmail, clean } = require('./security');
const i18n = require('./i18n');

const catalog = {
  locations: (all) => db.prepare(`SELECT * FROM locations ${all ? '' : 'WHERE active=1'} ORDER BY sort, id`).all(),
  tariffs: (all) => db.prepare(`SELECT * FROM tariffs ${all ? '' : 'WHERE active=1'} ORDER BY sort, id`).all(),
  addons: (all) => db.prepare(`SELECT * FROM addons ${all ? '' : 'WHERE active=1'} ORDER BY sort, id`).all(),
  tiers: () => db.prepare('SELECT min_bag_days, percent FROM discount_tiers ORDER BY min_bag_days').all(),
};

function withinHours(loc, time) {
  if (loc.open_24h) return true;
  return time >= loc.open_time && time <= loc.close_time;
}

// Bags already held at a location for any day overlapping [from, to]
function bagsBooked(locationId, from, to, excludeId) {
  return db.prepare(`SELECT COALESCE(SUM(bags),0) n FROM bookings
    WHERE location_id=? AND status IN ('pending','confirmed','checked_in')
      AND dropoff_at < ? AND pickup_at > ? AND id != ?`).get(locationId, to, from, excludeId || 0).n;
}

/**
 * Validate + price + insert. Returns { ok, booking, errors }.
 * opts.staff = true skips the "in the future" and opening-hours checks (walk-ins, back-dated entries).
 */
function createBooking(input, lang, opts = {}) {
  const errors = {};
  const tr = (k, v) => i18n.t(lang, k, v);
  const loc = db.prepare('SELECT * FROM locations WHERE id=? AND active=1').get(+input.location_id);
  const tariff = db.prepare('SELECT * FROM tariffs WHERE id=? AND active=1').get(+input.tariff_id);
  if (!loc) errors.location_id = tr('book.err.generic');
  if (!tariff) errors.tariff_id = tr('book.err.generic');

  const name = clean(input.customer_name, 120);
  const email = clean(input.email, 200).toLowerCase();
  const phone = clean(input.phone, 40);
  if (!name) errors.customer_name = tr('book.err.name');
  if (!isEmail(email) && !(opts.staff && !email)) errors.email = tr('book.err.email');
  if (!opts.staff && !input.terms) errors.terms = tr('book.err.terms');

  const date = /^\d{4}-\d{2}-\d{2}$/.test(input.date || '') ? input.date : null;
  const time = /^\d{2}:\d{2}$/.test(input.time || '') ? input.time : null;
  if (!date || !time) errors.date = tr('book.err.generic');
  const dropoff = date && time ? `${date} ${time}` : null;

  if (dropoff && !opts.staff) {
    const grace = addHours(nowLocal(), -0.25);
    if (dropoff < grace) errors.date = tr('book.err.past');
    else if (loc && !withinHours(loc, time)) errors.time = tr('book.err.hours', { hours: `${loc.open_time}–${loc.close_time}` });
  }
  if (Object.keys(errors).length) return { ok: false, errors };

  const addonIds = [].concat(input.addons || []).map(Number).filter(Boolean);
  const chosen = addonIds.length
    ? db.prepare(`SELECT * FROM addons WHERE active=1 AND id IN (${addonIds.map(() => '?').join(',')})`).all(...addonIds) : [];
  const q = P.quote(tariff, input.bags, input.days, chosen, catalog.tiers());
  const hours = tariff.mode === 'per_bag' ? tariff.hours : q.days * 24;
  const pickup = addHours(dropoff, hours);

  const used = bagsBooked(loc.id, dropoff, pickup);
  if (!opts.staff && used + q.bags > loc.capacity) return { ok: false, errors: { location_id: tr('book.err.full') } };

  const s = settings();
  let ref; do { ref = makeRef(); } while (db.prepare('SELECT 1 FROM bookings WHERE ref=?').get(ref));

  const tx = db.transaction(() => {
    const r = db.prepare(`INSERT INTO bookings (ref,token,lang,customer_name,email,phone,location_id,tariff_id,bags,days,dropoff_at,pickup_at,
        subtotal,discount,addons_total,total,currency,status,payment_status,payment_method,source,notes_customer,notes_internal)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      ref, token(), lang, name, email, phone, loc.id, tariff.id, q.bags, q.days, dropoff, pickup,
      q.subtotal, q.discount, q.addonsTotal, q.total, s.currency || 'EUR',
      opts.status || 'confirmed', opts.payment_status || 'unpaid', opts.payment_method || null,
      opts.source || 'web', clean(input.notes, 1000), clean(input.notes_internal, 1000));
    const ins = db.prepare('INSERT INTO booking_addons (booking_id,addon_id,name,unit_price,qty) VALUES (?,?,?,?,?)');
    chosen.forEach(a => ins.run(r.lastInsertRowid, a.id, a.name_en, a.price, a.per === 'bag' ? q.bags : 1));
    return r.lastInsertRowid;
  });
  const id = tx();
  const booking = getBooking(id);
  audit(opts.user, 'booking.create', 'booking', ref, { source: opts.source || 'web', total: q.total });
  return { ok: true, booking };
}

function getBooking(idOrRef) {
  const col = typeof idOrRef === 'number' || /^\d+$/.test(String(idOrRef)) ? 'b.id' : 'b.ref';
  const b = db.prepare(`SELECT b.*, l.name_en loc_name_en, l.name_tr loc_name_tr, l.address_en loc_address_en, l.address_tr loc_address_tr,
      l.lat, l.lng, l.slug loc_slug, t.name_en tariff_name_en, t.name_tr tariff_name_tr, t.mode tariff_mode
    FROM bookings b LEFT JOIN locations l ON l.id=b.location_id LEFT JOIN tariffs t ON t.id=b.tariff_id WHERE ${col}=?`).get(idOrRef);
  if (b) b.addons = db.prepare('SELECT * FROM booking_addons WHERE booking_id=?').all(b.id);
  return b;
}

// ---- Mail (optional: set SMTP_HOST etc. Otherwise emails are logged) ----
let transport = null;
if (process.env.SMTP_HOST) {
  const nodemailer = require('nodemailer');
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: +(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}
async function sendMail(to, subject, html) {
  const from = process.env.MAIL_FROM || `LuggagePark <${settings().email}>`;
  if (!transport) { console.log(`[mail:dev] to=${to} subject="${subject}"`); return; }
  try { await transport.sendMail({ from, to, subject, html }); }
  catch (e) { console.error('[mail] failed', e.message); }
}

function bookingEmailHtml(b) {
  const L = b.lang || 'en', s = settings();
  const t = (k, v) => i18n.t(L, k, v);
  const esc = x => String(x || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const link = `${s.site_url}${i18n.url(L, 'booking', b.ref)}?k=${b.token}`;
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#061A30">
  <p>${esc(t('email.hello', { name: b.customer_name }))}</p><p>${esc(t('email.body'))}</p>
  <div style="border:2px solid #061A30;border-radius:14px;padding:18px;margin:18px 0">
   <div style="font-size:13px;color:#51606f">${esc(t('conf.ref'))}</div>
   <div style="font-size:28px;font-weight:800;letter-spacing:.04em">${esc(b.ref)}</div>
   <p style="margin:12px 0 0"><b>${esc(t('conf.where'))}:</b> ${esc(b['loc_name_' + L])}<br>
   <b>${esc(t('conf.drop'))}:</b> ${esc(i18n.fmtDate(b.dropoff_at, L))}<br>
   <b>${esc(t('conf.collect'))}:</b> ${esc(i18n.fmtDate(b.pickup_at, L))}<br>
   <b>${esc(t('conf.bags'))}:</b> ${b.bags}<br>
   <b>${esc(t('conf.pay'))}:</b> ${esc(i18n.money(b.total, s, L))}</p>
  </div>
  <p><a href="${link}" style="background:#C23A06;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700">${esc(t('email.manage'))}</a></p>
  <p>${esc(t('email.thanks'))}<br>${esc(s.phone)}</p></div>`;
}

module.exports = { catalog, createBooking, getBooking, bagsBooked, sendMail, bookingEmailHtml, withinHours };
