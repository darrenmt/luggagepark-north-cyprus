'use strict';
const { db } = require('../db');
const dict = { en: require('./en'), tr: require('./tr') };
const LANGS = ['en', 'tr'];

// Localized URL slugs. Keys are page ids; value '' is the language home.
const ROUTES = {
  home: { en: '', tr: '' },
  how: { en: 'how-it-works', tr: 'nasil-calisir' },
  pricing: { en: 'prices', tr: 'fiyatlar' },
  locations: { en: 'locations', tr: 'noktalar' },
  business: { en: 'business', tr: 'isletmeler' },
  about: { en: 'about', tr: 'hakkimizda' },
  faq: { en: 'faq', tr: 'sss' },
  book: { en: 'book', tr: 'rezervasyon' },
  booking: { en: 'booking', tr: 'rezervasyonum' },
  track: { en: 'manage-booking', tr: 'rezervasyon-yonet' },
  contact: { en: 'contact', tr: 'iletisim' },
  privacy: { en: 'privacy', tr: 'gizlilik' },
  terms: { en: 'terms', tr: 'kosullar' },
};

// Admin-editable overrides (content table), cached in memory
let overrides = null;
function loadOverrides() {
  overrides = { en: {}, tr: {} };
  for (const r of db.prepare('SELECT key,en,tr FROM content').all()) {
    if (r.en) overrides.en[r.key] = r.en;
    if (r.tr) overrides.tr[r.key] = r.tr;
  }
}
function invalidate() { overrides = null; }

function t(lang, key, vars) {
  if (!overrides) loadOverrides();
  let s = overrides[lang][key] ?? dict[lang][key] ?? dict.en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
  return s;
}

function url(lang, page, extra) {
  const slug = ROUTES[page] ? ROUTES[page][lang] : page;
  let u = `/${lang}/` + (slug ? slug : '');
  if (extra) u += (slug ? '/' : '') + extra;
  return u;
}

function money(n, s, lang) {
  const sym = (s && s.currency_symbol) || '€';
  const v = Number(n || 0);
  const str = v % 1 === 0 ? v.toFixed(0) : v.toFixed(2);
  const loc = lang === 'tr' ? str.replace('.', ',') : str;
  return sym + loc;
}

const TZ = 'Europe/Nicosia';
function fmtDate(iso, lang, opts) {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T') + (iso.length <= 16 ? ':00' : ''));
  return new Intl.DateTimeFormat(lang === 'tr' ? 'tr-TR' : 'en-GB', Object.assign({ weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }, opts || {})).format(d);
}

// Pick the localized field of a DB row: loc(row,'name') -> row.name_tr / row.name_en
function field(row, name, lang) { return row ? (row[`${name}_${lang}`] || row[`${name}_en`] || '') : ''; }

module.exports = { t, url, money, fmtDate, field, LANGS, ROUTES, invalidate, dict, TZ };
