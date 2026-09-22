'use strict';
require('./src/load-env');
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const compression = require('compression');
const { SqliteStore } = require('./src/security');
const { settings } = require('./src/db');

if (PROD_CHECK()) { console.error('Set SESSION_SECRET before running in production.'); process.exit(1); }
function PROD_CHECK() { return process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET; }
const app = express();
const PROD = process.env.NODE_ENV === 'production';
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https://*.tile.openstreetmap.org'],
      frameSrc: ['https://www.openstreetmap.org'],
      formAction: ["'self'"],
      upgradeInsecureRequests: PROD ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: PROD ? '7d' : 0, index: false }));
app.use(express.urlencoded({ extended: true, limit: '200kb' }));

app.use(session({
  store: new SqliteStore(),
  name: 'lp.sid',
  secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
  resave: false, saveUninitialized: false, rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 1000 * 60 * 60 * 12 },
}));

app.use((req, res, next) => { res.locals.settings = settings(); res.locals.assetV = ASSET_V; next(); });
const ASSET_V = Date.now().toString(36);

app.use('/admin', require('./src/routes/admin'));
app.use('/', require('./src/routes/public'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong. Please try again.');
});

const PORT = process.env.PORT || 3000;
if (require.main === module) app.listen(PORT, () => console.log(`LuggagePark running on http://localhost:${PORT}`));
module.exports = app;
