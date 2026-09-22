/* Rebuilds the project's folder structure when files were uploaded to GitHub
   without folders (everything flat in the repo root). Runs automatically after
   "npm install" / "npm ci". Safe to run more than once. */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const MANIFEST = ["public/css/admin.css", "public/css/site.css", "public/favicon.ico", "public/fonts/bricolage-grotesque-latin-ext-wght-normal.woff2", "public/fonts/bricolage-grotesque-latin-wght-normal.woff2", "public/fonts/figtree-latin-ext-wght-normal.woff2", "public/fonts/figtree-latin-wght-normal.woff2", "public/img/android-chrome-192x192.png", "public/img/android-chrome-512x512.png", "public/img/apple-touch-icon-180x180.png", "public/img/icon-192.png", "public/img/icon-512.png", "public/img/logo-600.png", "public/img/logo.png", "public/img/og.png", "public/js/admin.js", "public/js/pricing.js", "public/js/site.js", "src/admin-icons.js", "src/bookings.js", "src/db.js", "src/i18n/en.js", "src/i18n/index.js", "src/i18n/tr.js", "src/load-env.js", "src/routes/admin.js", "src/routes/public.js", "src/security.js", "views/admin/_bottom.ejs", "views/admin/_status.ejs", "views/admin/_top.ejs", "views/admin/account.ejs", "views/admin/audit.ejs", "views/admin/booking-new.ejs", "views/admin/booking.ejs", "views/admin/bookings.ejs", "views/admin/content.ejs", "views/admin/crud-form.ejs", "views/admin/crud-list.ejs", "views/admin/dashboard.ejs", "views/admin/discounts.ejs", "views/admin/enquiries.ejs", "views/admin/error.ejs", "views/admin/login.ejs", "views/admin/settings.ejs", "views/admin/users.ejs", "views/pages/about.ejs", "views/pages/book.ejs", "views/pages/booking.ejs", "views/pages/business.ejs", "views/pages/contact.ejs", "views/pages/error.ejs", "views/pages/faq.ejs", "views/pages/home.ejs", "views/pages/how.ejs", "views/pages/legal.ejs", "views/pages/location.ejs", "views/pages/locations.ejs", "views/pages/pricing.ejs", "views/pages/track.ejs", "views/partials/bottom.ejs", "views/partials/crumbs.ejs", "views/partials/cta.ejs", "views/partials/enquiry-form.ejs", "views/partials/icon.ejs", "views/partials/pagehero.ejs", "views/partials/prices.ejs", "views/partials/top.ejs"];

// Files whose names appear twice; tell them apart by content.
const SIGNATURE = {
  'src/routes/admin.js': s => s.includes('express.Router'),
  'public/js/admin.js': s => !s.includes('express.Router'),
  'views/admin/error.ejs': s => s.includes("include('_top')"),
  'views/pages/error.ejs': s => s.includes('../partials/top'),
  'views/admin/booking.ejs': s => s.includes("include('_top')"),
  'views/pages/booking.ejs': s => s.includes('../partials/top'),
};

if (fs.existsSync(path.join(ROOT, 'src', 'routes', 'public.js'))) {
  console.log('[setup-folders] folders already in place');
  process.exit(0);
}

const rootFiles = fs.readdirSync(ROOT).filter(f => fs.statSync(path.join(ROOT, f)).isFile());
// "admin (1).js" -> "admin.js"
const baseOf = f => f.replace(/ \(\d+\)(\.[^.]+)$/, '$1');
const used = new Set();
let moved = 0, missing = [];

for (const target of MANIFEST) {
  const name = path.basename(target);
  const candidates = rootFiles.filter(f => !used.has(f) && baseOf(f) === name);
  let pick = null;
  if (candidates.length === 1 && !SIGNATURE[target]) pick = candidates[0];
  else if (candidates.length) {
    const test = SIGNATURE[target];
    pick = candidates.find(f => {
      if (!test) return true;
      const buf = fs.readFileSync(path.join(ROOT, f));
      return test(buf.toString('utf8'));
    }) || null;
  }
  if (!pick) { missing.push(target); continue; }
  const dest = path.join(ROOT, target);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(path.join(ROOT, pick), dest);
  used.add(pick); moved++;
}
console.log('[setup-folders] moved ' + moved + ' files into folders');
if (missing.length) {
  console.error('[setup-folders] MISSING files (upload them to GitHub): ' + missing.join(', '));
  process.exit(1);
}
