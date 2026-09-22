# LuggagePark North Cyprus

Bilingual (English / Turkish) luggage storage website with online booking and a full staff admin panel.

- **Public site:** server-rendered pages in English and Turkish, localized URLs, a live price calculator and a booking form.
- **Bookings:** priced on the server, checked against opening hours and capacity, with a QR ticket that customers can view or cancel.
- **Admin:** dashboard, check-in and collection, walk-ins, payments, locations, prices, extras, discounts, FAQs, a site text editor, team roles, CSV export, backups and an activity log.
- **Stack:** Node.js 20+, Express, SQLite (better-sqlite3), EJS. No build step and no front-end framework.

## Run it locally

```bash
npm install
cp .env.example .env        # then edit it
npm start                   # http://localhost:3000
```

On first start the database is created in `data/` and seeded with 7 North Cyprus locations, 4 plans, 5 extras, discounts and FAQs. An owner account is also created from `ADMIN_EMAIL` and `ADMIN_PASSWORD`. If you don't set these, it falls back to `admin@luggagepark.com` / `ChangeMe!2026`, so change that password straight away.

Admin lives at **/admin**.

## Deploy

This app needs a server, so it can't run on GitHub Pages. It also needs a **persistent disk**, because that's where the database lives.

**Render (easiest):** push this folder to GitHub, then in Render choose *New → Blueprint* and pick the repo. `render.yaml` creates the web service with a 1 GB disk. Set `SITE_URL`, `ADMIN_EMAIL` and `ADMIN_PASSWORD` when prompted, then point your domain at it.

**Railway / Fly / any VPS:** use the `Dockerfile` and mount a volume at `/data`. Set the env vars from `.env.example`. `SESSION_SECRET` is required in production.

After deploying:
1. Sign in to `/admin` and change your password (Your account).
2. In **Settings**, set the public site address, phone, WhatsApp, email and currency.
3. In **Locations**, replace the placeholder addresses, coordinates and hours with your real Points.
4. Submit `https://yourdomain/sitemap.xml` in Google Search Console and Bing Webmaster Tools.
5. Create a Google Business Profile for each Point, and link it to that Point's page on the site.

## Email

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM`. Brevo, Postmark, Mailgun or a Google Workspace SMTP relay all work.

Without email configured, bookings still work. Emails are written to the server log, and customers still see their confirmation page.

## Roles

| Role | Can do |
|---|---|
| Staff | Dashboard, bookings, check-in and collection, walk-ins, payments, enquiries. Can be limited to one location, in which case they only see that location's bookings. |
| Manager | Everything staff can do, plus locations, prices, extras, discounts, FAQs, site text, CSV export, refunds and the activity log. |
| Owner | Everything, plus team, settings and backups. |

## Day-to-day at the desk

- A customer shows the QR code. Scan it with a signed-in phone and it opens their booking. Tap **Check in**, enter the tag numbers, done.
- Or type the reference, name, phone or tag number into the search bar. On desktop, press `/` to jump to it.
- At collection, tick **Paid now**, choose cash or card, then **Mark as collected**.
- For walk-ins, use **New booking**. Email is optional.

## SEO built in

- Every page exists in English (`/en/…`) and Turkish (`/tr/…`), with `hreflang` alternates, canonical URLs and localized titles and descriptions.
- One indexable page per location, marked up as a local business with map coordinates and opening hours.
- Structured data for the FAQ page, pricing and breadcrumbs.
- A dynamic `sitemap.xml` with language alternates; `robots.txt` blocks `/admin` and private booking pages.
- Fast pages: self-hosted fonts, compression, no tracking scripts, and one small JS file.

## Project layout

```
server.js               app entry, security headers, sessions
src/db.js               schema + seed data
src/bookings.js         pricing, validation, capacity, email
src/i18n/{en,tr}.js     all site text (admin "Site text" can override any line)
src/routes/public.js    public pages, booking, SEO, sitemap
src/routes/admin.js     admin panel
views/pages, views/admin, views/partials
public/css, public/js, public/fonts, public/img
```

## Not included yet (good next steps)

- **Online card payment:** iyzico or Stripe. The booking record already has payment status and method fields.
- **Booking reminders:** WhatsApp or SMS the day before.
- **Photo upload at check-in:** needs file storage such as S3 or Cloudflare R2.
- **Reviews** on each location page.
