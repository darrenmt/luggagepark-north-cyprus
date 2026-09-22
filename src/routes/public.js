'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const { db, settings, audit } = require('../db');
const i18n = require('../i18n');
const { csrf, nowLocal, todayLocal, addHours, isEmail, clean } = require('../security');
const { catalog, createBooking, getBooking, sendMail, bookingEmailHtml } = require('../bookings');

const router = express.Router();
const { LANGS, ROUTES } = i18n;

const formLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).send(i18n.t(req.params.lang || 'en', 'book.err.rate')) });

// ---------- shared locals ----------
function setup(lang, req, res, altPaths) {
  const s = settings();
  const L = res.locals;
  L.lang = lang;
  L.t = (k, v) => i18n.t(lang, k, v);
  L.url = (p, extra) => i18n.url(lang, p, extra);
  L.money = n => i18n.money(n, s, lang);
  L.fmtDate = (d, o) => i18n.fmtDate(d, lang, o);
  L.f = (row, name) => i18n.field(row, name, lang);
  L.alt = altPaths; // { en: '/en/..', tr: '/tr/..' }
  L.other = lang === 'en' ? 'tr' : 'en';
  L.siteUrl = (s.site_url || '').replace(/\/$/, '');
  L.canonical = L.siteUrl + altPaths[lang];
  L.path = req.path;
  L.fromPrice = Math.min(...catalog.tariffs().filter(x => x.mode !== 'flat').map(x => x.price), 99);
  L.nl2br = str => String(str || '').split('\n').map(x => x.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))).join('<br>');
  L.hours = loc => loc.open_24h ? L.t('loc.open24') : `${loc.open_time}–${loc.close_time}`;
  L.jsonld = [];
  L.footerLocations = catalog.locations();
  L.breadcrumbs = null;
}

function orgLd(res) {
  const s = settings(), base = res.locals.siteUrl;
  return {
    '@context': 'https://schema.org', '@type': 'Organization', '@id': base + '/#org',
    name: 'LuggagePark', url: base + '/', logo: base + '/img/logo-600.png',
    contactPoint: [{ '@type': 'ContactPoint', telephone: s.phone, email: s.email, contactType: 'customer service', availableLanguage: ['English', 'Turkish'] }],
    areaServed: { '@type': 'Place', name: 'North Cyprus' },
  };
}
function locationLd(loc, lang, res) {
  const base = res.locals.siteUrl;
  return {
    '@context': 'https://schema.org', '@type': 'LocalBusiness', additionalType: 'https://schema.org/SelfStorage',
    '@id': `${base}${i18n.url(lang, 'locations', loc.slug)}#place`,
    name: `LuggagePark – ${i18n.field(loc, 'name', lang)}`, image: base + '/img/og.png',
    url: base + i18n.url(lang, 'locations', loc.slug), telephone: loc.phone || settings().phone,
    priceRange: `${settings().currency_symbol}${res.locals.fromPrice}+`,
    address: { '@type': 'PostalAddress', streetAddress: i18n.field(loc, 'address', lang), addressLocality: loc.town, addressRegion: 'North Cyprus', addressCountry: 'CY' },
    geo: loc.lat ? { '@type': 'GeoCoordinates', latitude: loc.lat, longitude: loc.lng } : undefined,
    openingHoursSpecification: [{ '@type': 'OpeningHoursSpecification',
      dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
      opens: loc.open_24h ? '00:00' : loc.open_time, closes: loc.open_24h ? '23:59' : loc.close_time }],
    parentOrganization: { '@id': base + '/#org' },
  };
}
function crumbs(res, items) {
  const base = res.locals.siteUrl;
  res.locals.breadcrumbs = items;
  res.locals.jsonld.push({ '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: base + it.href })) });
}

// Register a localized page. handler(req,res,lang) renders.
function page(key, handler, opts = {}) {
  for (const lang of LANGS) {
    const alt = Object.fromEntries(LANGS.map(l => [l, i18n.url(l, key)]));
    const path = alt[lang];
    router.get(path, csrf, (req, res, next) => { setup(lang, req, res, alt); Promise.resolve(handler(req, res, lang)).catch(next); });
    if (path !== `/${lang}/`) router.get(path + '/', (req, res) => res.redirect(301, path));
  }
}
function render(res, view, key, extra = {}) {
  const L = res.locals;
  res.render('pages/' + view, Object.assign({
    title: extra.title || L.t(`meta.${key}.title`),
    description: extra.description || L.t(`meta.${key}.desc`),
    pageKey: key,
  }, extra));
}

// ---------- root, robots, sitemap, manifest ----------
router.get('/', (req, res) => {
  const al = (req.get('accept-language') || '').toLowerCase();
  res.set('Vary', 'Accept-Language');
  res.redirect(302, /^tr|,\s*tr/.test(al) ? '/tr/' : '/en/');
});

router.get('/robots.txt', (req, res) => {
  const base = (settings().site_url || '').replace(/\/$/, '');
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /en/booking/\nDisallow: /tr/rezervasyonum/\n\nSitemap: ${base}/sitemap.xml\n`);
});

router.get('/sitemap.xml', (req, res) => {
  const base = (settings().site_url || '').replace(/\/$/, '');
  const pages = ['home', 'how', 'pricing', 'locations', 'book', 'business', 'faq', 'about', 'contact', 'privacy', 'terms'];
  const entries = pages.map(k => ({ en: i18n.url('en', k), tr: i18n.url('tr', k), pr: k === 'home' ? '1.0' : ['pricing', 'locations', 'book'].includes(k) ? '0.9' : '0.6' }));
  catalog.locations().forEach(l => entries.push({ en: i18n.url('en', 'locations', l.slug), tr: i18n.url('tr', 'locations', l.slug), pr: '0.8' }));
  const today = new Date().toISOString().slice(0, 10);
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n';
  for (const e of entries) for (const l of LANGS) {
    xml += `<url><loc>${base}${e[l]}</loc><lastmod>${today}</lastmod><priority>${e.pr}</priority>` +
      LANGS.map(x => `<xhtml:link rel="alternate" hreflang="${x}" href="${base}${e[x]}"/>`).join('') +
      `<xhtml:link rel="alternate" hreflang="x-default" href="${base}${e.en}"/></url>\n`;
  }
  res.type('application/xml').send(xml + '</urlset>');
});

router.get('/site.webmanifest', (req, res) => res.json({
  name: 'LuggagePark North Cyprus', short_name: 'LuggagePark', start_url: '/', display: 'standalone',
  background_color: '#ffffff', theme_color: '#061A30',
  icons: [{ src: '/img/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' }, { src: '/img/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' }],
}));

// ---------- pages ----------
page('home', (req, res, lang) => {
  const locations = catalog.locations(), tariffs = catalog.tariffs();
  const faqs = db.prepare('SELECT * FROM faqs WHERE active=1 AND featured=1 ORDER BY sort LIMIT 5').all();
  const base = res.locals.siteUrl;
  res.locals.jsonld.push(orgLd(res), {
    '@context': 'https://schema.org', '@type': 'WebSite', name: 'LuggagePark', url: base + '/', inLanguage: lang,
  });
  render(res, 'home', 'home', { locations, tariffs, faqs, tiers: catalog.tiers() });
});

page('how', (req, res, lang) => {
  crumbs(res, [{ name: 'LuggagePark', href: i18n.url(lang, 'home') }, { name: res.locals.t('nav.how'), href: i18n.url(lang, 'how') }]);
  res.locals.jsonld.push({ '@context': 'https://schema.org', '@type': 'HowTo', name: res.locals.t('how.h1'),
    step: [1, 2, 3, 4].map(n => ({ '@type': 'HowToStep', name: res.locals.t(`step${n}.h`), text: res.locals.t(`step${n}.p`) })) });
  render(res, 'how', 'how');
});

page('pricing', (req, res, lang) => {
  const tariffs = catalog.tariffs(), addons = catalog.addons();
  crumbs(res, [{ name: 'LuggagePark', href: i18n.url(lang, 'home') }, { name: res.locals.t('nav.pricing'), href: i18n.url(lang, 'pricing') }]);
  res.locals.jsonld.push({ '@context': 'https://schema.org', '@type': 'Service', serviceType: 'Luggage storage', provider: { '@id': res.locals.siteUrl + '/#org' },
    areaServed: 'North Cyprus', offers: tariffs.map(x => ({ '@type': 'Offer', name: i18n.field(x, 'name', lang), price: x.price, priceCurrency: settings().currency })) });
  render(res, 'pricing', 'pricing', { tariffs, addons, tiers: catalog.tiers() });
});

page('locations', (req, res, lang) => {
  const locations = catalog.locations();
  crumbs(res, [{ name: 'LuggagePark', href: i18n.url(lang, 'home') }, { name: res.locals.t('nav.locations'), href: i18n.url(lang, 'locations') }]);
  res.locals.jsonld.push(...locations.map(l => locationLd(l, lang, res)));
  const towns = {};
  locations.forEach(l => (towns[l.town] = towns[l.town] || []).push(l));
  render(res, 'locations', 'locations', { towns });
});

// Location detail pages (strong local SEO: one indexable page per Point, per language)
for (const lang of LANGS) {
  router.get(i18n.url(lang, 'locations') + '/:slug', csrf, (req, res) => {
    const loc = db.prepare('SELECT * FROM locations WHERE slug=? AND active=1').get(req.params.slug);
    const alt = Object.fromEntries(LANGS.map(l => [l, i18n.url(l, 'locations', req.params.slug)]));
    setup(lang, req, res, alt);
    if (!loc) return notFound(req, res, lang);
    const L = res.locals, name = i18n.field(loc, 'name', lang);
    crumbs(res, [{ name: 'LuggagePark', href: i18n.url(lang, 'home') }, { name: L.t('nav.locations'), href: i18n.url(lang, 'locations') }, { name, href: alt[lang] }]);
    L.jsonld.push(locationLd(loc, lang, res));
    const others = catalog.locations().filter(x => x.id !== loc.id);
    render(res, 'location', 'location', {
      loc, others, tariffs: catalog.tariffs(),
      title: L.t('meta.location.title', { name }),
      description: L.t('meta.location.desc', { name, town: L.t('loc.town.' + loc.town), best: i18n.field(loc, 'best_for', lang), hours: L.hours(loc), from: L.money(L.fromPrice) }),
    });
  });
}

page('business', (req, res) => render(res, 'business', 'business', { sent: req.query.sent, error: null, form: {} }));
page('about', (req, res) => render(res, 'about', 'about'));
page('faq', (req, res, lang) => {
  const faqs = db.prepare('SELECT * FROM faqs WHERE active=1 ORDER BY sort, id').all();
  const groups = {};
  faqs.forEach(q => (groups[q.category] = groups[q.category] || []).push(q));
  res.locals.jsonld.push({ '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: faqs.map(q => ({ '@type': 'Question', name: i18n.field(q, 'q', lang), acceptedAnswer: { '@type': 'Answer', text: i18n.field(q, 'a', lang) } })) });
  render(res, 'faq', 'faq', { groups });
});
page('contact', (req, res) => render(res, 'contact', 'contact', { sent: req.query.sent, error: null, form: { type: req.query.type || 'general' } }));
page('privacy', (req, res) => render(res, 'legal', 'privacy', { which: 'privacy', description: res.locals.t('privacy.body').slice(0, 155) }));
page('terms', (req, res) => render(res, 'legal', 'terms', { which: 'terms', description: res.locals.t('terms.body').slice(0, 155) }));
page('track', (req, res) => render(res, 'track', 'track', { error: null, form: {} }));

function bookData() {
  return { locations: catalog.locations(), tariffs: catalog.tariffs(), addons: catalog.addons(), tiers: catalog.tiers() };
}
page('book', (req, res) => {
  const d = bookData();
  const q = req.query;
  const locBySlug = q.loc ? d.locations.find(l => l.slug === q.loc) : null;
  const tarByCode = q.plan ? d.tariffs.find(t => t.code === q.plan) : null;
  const now = nowLocal();
  let time = addHours(now, 1).slice(11, 13) + ':00';
  const form = {
    location_id: locBySlug ? locBySlug.id : (d.locations[0] || {}).id,
    tariff_id: tarByCode ? tarByCode.id : (d.tariffs.find(t => t.featured) || d.tariffs[0] || {}).id,
    bags: Math.max(1, Math.min(+q.bags || 1, 20)), days: +q.days || 2,
    date: time < now.slice(11) ? addHours(now, 24).slice(0, 10) : todayLocal(), time,
  };
  render(res, 'book', 'book', Object.assign(d, { form, errors: {}, minDate: todayLocal() }));
});

// POST booking
for (const lang of LANGS) {
  router.post(i18n.url(lang, 'book'), formLimiter, csrf, async (req, res, next) => {
    try {
      if (req.body.website) return res.redirect(i18n.url(lang, 'home')); // honeypot
      const result = createBooking(req.body, lang, { source: 'web' });
      if (!result.ok) {
        setup(lang, req, res, Object.fromEntries(LANGS.map(l => [l, i18n.url(l, 'book')])));
        res.status(422); return render(res, 'book', 'book', Object.assign(bookData(), { form: req.body, errors: result.errors, minDate: todayLocal() }));
      }
      const b = result.booking;
      sendMail(b.email, i18n.t(lang, 'email.subject', { ref: b.ref }), bookingEmailHtml(b));
      const notify = settings().booking_notice_email;
      if (notify) sendMail(notify, `New booking ${b.ref} – ${b.loc_name_en}`, `<p>${b.customer_name} · ${b.bags} bag(s) · ${b.dropoff_at} · ${b.total}</p>`);
      res.redirect(303, `${i18n.url(lang, 'booking', b.ref)}?k=${b.token}&new=1`);
    } catch (e) { next(e); }
  });
}

// Confirmation / manage page (token protected)
for (const lang of LANGS) {
  router.get(i18n.url(lang, 'booking') + '/:ref', csrf, async (req, res, next) => {
    try {
      const alt = Object.fromEntries(LANGS.map(l => [l, i18n.url(l, 'booking', req.params.ref) + (req.query.k ? `?k=${encodeURIComponent(req.query.k)}` : '')]));
      setup(lang, req, res, alt);
      res.set('X-Robots-Tag', 'noindex');
      const b = getBooking(String(req.params.ref).toUpperCase());
      if (!b || b.token !== req.query.k) return notFound(req, res, lang);
      const s = settings();
      const qr = await QRCode.toString(`${s.site_url.replace(/\/$/, '')}/admin/b/${b.ref}`, { type: 'svg', margin: 0, color: { dark: '#061A30', light: '#0000' } });
      const canCancel = ['pending', 'confirmed'].includes(b.status) && addHours(nowLocal(), 1) <= b.dropoff_at;
      render(res, 'booking', 'track', { b, qr, canCancel, isNew: !!req.query.new, noindex: true, title: `${b.ref} – LuggagePark` });
    } catch (e) { next(e); }
  });
  router.post(i18n.url(lang, 'booking') + '/:ref/cancel', formLimiter, csrf, (req, res) => {
    const b = getBooking(String(req.params.ref).toUpperCase());
    if (!b || b.token !== req.body.k) return res.redirect(i18n.url(lang, 'track'));
    if (['pending', 'confirmed'].includes(b.status) && addHours(nowLocal(), 1) <= b.dropoff_at) {
      db.prepare("UPDATE bookings SET status='cancelled', updated_at=datetime('now') WHERE id=?").run(b.id);
      audit(null, 'booking.cancel.customer', 'booking', b.ref);
    }
    res.redirect(303, `${i18n.url(lang, 'booking', b.ref)}?k=${b.token}`);
  });
  router.post(i18n.url(lang, 'track'), formLimiter, csrf, (req, res) => {
    const ref = clean(req.body.ref, 20).toUpperCase().replace(/^LP(?!-)/, 'LP-');
    const b = getBooking(ref);
    if (b && b.email === clean(req.body.email, 200).toLowerCase()) return res.redirect(303, `${i18n.url(lang, 'booking', b.ref)}?k=${b.token}`);
    setup(lang, req, res, Object.fromEntries(LANGS.map(l => [l, i18n.url(l, 'track')])));
    res.status(404); render(res, 'track', 'track', { error: res.locals.t('track.notfound'), form: req.body });
  });

  // Contact + business enquiries
  for (const key of ['contact', 'business']) {
    router.post(i18n.url(lang, key), formLimiter, csrf, (req, res) => {
      if (req.body.website) return res.redirect(i18n.url(lang, key) + '?sent=1');
      const f = { name: clean(req.body.name, 120), email: clean(req.body.email, 200).toLowerCase(), phone: clean(req.body.phone, 40),
        company: clean(req.body.company, 160), message: clean(req.body.message, 4000),
        type: ['general', 'booking', 'business', 'host'].includes(req.body.type) ? req.body.type : (key === 'business' ? 'business' : 'general') };
      if (!f.name || !isEmail(f.email) || f.message.length < 2) {
        setup(lang, req, res, Object.fromEntries(LANGS.map(l => [l, i18n.url(l, key)])));
        res.status(422); return render(res, key, key, { sent: false, error: res.locals.t('contact.err'), form: f });
      }
      db.prepare('INSERT INTO enquiries (type,name,email,phone,company,message,lang) VALUES (?,?,?,?,?,?,?)').run(f.type, f.name, f.email, f.phone, f.company, f.message, lang);
      const notify = settings().email;
      if (notify) sendMail(notify, `New ${f.type} enquiry from ${f.name}`, `<p>${f.name} (${f.email}, ${f.phone})</p><p>${f.message.replace(/</g, '&lt;')}</p>`);
      res.redirect(303, i18n.url(lang, key) + '?sent=1#form');
    });
  }
}

// Live price API used by the booking form (read-only)
router.get('/api/catalog', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ tariffs: catalog.tariffs().map(t => ({ id: t.id, code: t.code, mode: t.mode, price: t.price, hours: t.hours, min_days: t.min_days, max_days: t.max_days, max_bags: t.max_bags })),
    addons: catalog.addons().map(a => ({ id: a.id, price: a.price, per: a.per })), tiers: catalog.tiers() });
});

function notFound(req, res, lang) {
  if (!res.locals.t) setup(lang, req, res, { en: '/en/', tr: '/tr/' });
  res.status(404);
  render(res, 'error', 'home', { code: 404, title: res.locals.t('misc.404.h1'), noindex: true });
}
router.use((req, res) => {
  const lang = req.path.startsWith('/tr') ? 'tr' : 'en';
  setup(lang, req, res, { en: '/en/', tr: '/tr/' });
  notFound(req, res, lang);
});

module.exports = router;
