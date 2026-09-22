'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'luggagepark.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'staff',
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1, last_login TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, town TEXT NOT NULL,
  name_en TEXT NOT NULL, name_tr TEXT NOT NULL,
  address_en TEXT, address_tr TEXT, desc_en TEXT, desc_tr TEXT,
  best_for_en TEXT, best_for_tr TEXT,
  lat REAL, lng REAL, open_time TEXT DEFAULT '07:00', close_time TEXT DEFAULT '23:00',
  open_24h INTEGER DEFAULT 0, capacity INTEGER DEFAULT 60, phone TEXT,
  step_free INTEGER DEFAULT 1, active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tariffs (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL,
  name_en TEXT NOT NULL, name_tr TEXT NOT NULL, desc_en TEXT, desc_tr TEXT,
  unit_en TEXT, unit_tr TEXT, features_en TEXT, features_tr TEXT,
  mode TEXT NOT NULL DEFAULT 'per_bag',          -- per_bag | per_bag_day | flat
  price REAL NOT NULL, hours INTEGER DEFAULT 24, min_days INTEGER DEFAULT 1, max_days INTEGER DEFAULT 1,
  max_bags INTEGER DEFAULT 20, featured INTEGER DEFAULT 0, active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS addons (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL,
  name_en TEXT NOT NULL, name_tr TEXT NOT NULL, desc_en TEXT, desc_tr TEXT,
  price REAL NOT NULL, per TEXT NOT NULL DEFAULT 'booking',  -- booking | bag
  active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS discount_tiers (
  id INTEGER PRIMARY KEY, min_bag_days INTEGER NOT NULL, percent REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY, ref TEXT UNIQUE NOT NULL, token TEXT NOT NULL, lang TEXT DEFAULT 'en',
  customer_name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT,
  location_id INTEGER REFERENCES locations(id), tariff_id INTEGER REFERENCES tariffs(id),
  bags INTEGER NOT NULL, days INTEGER NOT NULL DEFAULT 1,
  dropoff_at TEXT NOT NULL, pickup_at TEXT NOT NULL,
  subtotal REAL NOT NULL, discount REAL NOT NULL DEFAULT 0, addons_total REAL NOT NULL DEFAULT 0, total REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  status TEXT NOT NULL DEFAULT 'confirmed',        -- pending|confirmed|checked_in|collected|cancelled|no_show
  payment_status TEXT NOT NULL DEFAULT 'unpaid',   -- unpaid|paid|refunded
  payment_method TEXT,                             -- cash|card|online|invoice
  source TEXT NOT NULL DEFAULT 'web',              -- web|walkin|phone|partner
  notes_customer TEXT, notes_internal TEXT, tag_numbers TEXT,
  checked_in_at TEXT, collected_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bookings_drop ON bookings(dropoff_at);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_loc ON bookings(location_id);
CREATE TABLE IF NOT EXISTS booking_addons (
  id INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  addon_id INTEGER, name TEXT NOT NULL, unit_price REAL NOT NULL, qty INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS enquiries (
  id INTEGER PRIMARY KEY, type TEXT DEFAULT 'general', name TEXT NOT NULL, email TEXT NOT NULL,
  phone TEXT, company TEXT, message TEXT NOT NULL, lang TEXT DEFAULT 'en',
  status TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS faqs (
  id INTEGER PRIMARY KEY, category TEXT DEFAULT 'general',
  q_en TEXT NOT NULL, q_tr TEXT NOT NULL, a_en TEXT NOT NULL, a_tr TEXT NOT NULL,
  sort INTEGER DEFAULT 0, active INTEGER DEFAULT 1, featured INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS content (key TEXT PRIMARY KEY, en TEXT, tr TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, user_id INTEGER, user_name TEXT, action TEXT NOT NULL,
  entity TEXT, entity_id TEXT, detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL);
`);

function seed() {
  const has = db.prepare('SELECT COUNT(*) n FROM locations').get().n;
  if (has) return;

  const loc = db.prepare(`INSERT INTO locations (slug,town,name_en,name_tr,address_en,address_tr,desc_en,desc_tr,best_for_en,best_for_tr,lat,lng,open_time,close_time,open_24h,capacity,step_free,sort)
    VALUES (@slug,@town,@name_en,@name_tr,@address_en,@address_tr,@desc_en,@desc_tr,@best_for_en,@best_for_tr,@lat,@lng,@open_time,@close_time,@open_24h,@capacity,@step_free,@sort)`);
  const L = [
    { slug: 'ercan-airport', town: 'Lefkoşa', name_en: 'Ercan Airport (ECN)', name_tr: 'Ercan Havalimanı (ECN)',
      address_en: 'Arrivals hall, next to the car-hire desks', address_tr: 'Geliş salonu, araç kiralama bankolarının yanı',
      desc_en: 'Landed early and your room isn\'t ready? Checked out at noon with a midnight flight? Leave the cases with us in arrivals and go.',
      desc_tr: 'Erken indiniz ve odanız hazır değil mi? Öğlen çıkış yaptınız, uçağınız gece yarısı mı? Bavulları geliş salonunda bize bırakın, yolunuza devam edin.',
      best_for_en: 'Early arrivals and late flights', best_for_tr: 'Erken varış ve geç uçuşlar',
      lat: 35.1547, lng: 33.4961, open_time: '00:00', close_time: '23:59', open_24h: 1, capacity: 150, step_free: 1, sort: 1 },
    { slug: 'kyrenia-old-harbour', town: 'Girne', name_en: 'Kyrenia Old Harbour', name_tr: 'Girne Antik Liman',
      address_en: 'Harbour road, a two-minute walk from Kyrenia Castle', address_tr: 'Liman yolu, Girne Kalesi\'ne iki dakika yürüme mesafesi',
      desc_en: 'Right on the horseshoe harbour. Store your bags, have lunch by the water, walk up to the castle and the shipwreck museum.',
      desc_tr: 'Nal şeklindeki limanın tam üzerinde. Bavullarınızı bırakın, deniz kenarında öğle yemeği yiyin, kaleye ve Batık Gemi Müzesi\'ne çıkın.',
      best_for_en: 'Hotel checkout days and harbour walks', best_for_tr: 'Otel çıkış günleri ve liman gezileri',
      lat: 35.3417, lng: 33.3192, open_time: '07:00', close_time: '23:00', open_24h: 0, capacity: 80, step_free: 1, sort: 2 },
    { slug: 'kyrenia-ferry-port', town: 'Girne', name_en: 'Kyrenia Ferry Port', name_tr: 'Girne Turizm Limanı',
      address_en: 'Passenger terminal forecourt', address_tr: 'Yolcu terminali önü',
      desc_en: 'For ferry passengers to and from Taşucu, Mersin and Alanya. Drop the heavy bags before a day in town and collect on your way to the boat.',
      desc_tr: 'Taşucu, Mersin ve Alanya feribot yolcuları için. Şehirde geçireceğiniz günden önce ağır bavulları bırakın, gemiye giderken alın.',
      best_for_en: 'Ferry passengers', best_for_tr: 'Feribot yolcuları',
      lat: 35.3460, lng: 33.3365, open_time: '06:00', close_time: '23:00', open_24h: 0, capacity: 100, step_free: 1, sort: 3 },
    { slug: 'nicosia-kyrenia-gate', town: 'Lefkoşa', name_en: 'Nicosia – Kyrenia Gate', name_tr: 'Lefkoşa – Girne Kapısı',
      address_en: 'Inside the walls, by Kyrenia Gate on İnönü Square', address_tr: 'Surlar içi, İnönü Meydanı\'nda Girne Kapısı yanı',
      desc_en: 'Ten minutes on foot to the Lokmacı crossing, the Büyük Han and Selimiye Mosque. Ideal if you\'re crossing over for the day.',
      desc_tr: 'Lokmacı sınır kapısına, Büyük Han\'a ve Selimiye Camii\'ne yürüyerek on dakika. Günübirlik geçiş yapanlar için ideal.',
      best_for_en: 'Day trips across the crossing', best_for_tr: 'Sınır kapısından günübirlik geçişler',
      lat: 35.1813, lng: 33.3620, open_time: '07:00', close_time: '22:00', open_24h: 0, capacity: 60, step_free: 1, sort: 4 },
    { slug: 'famagusta-old-town', town: 'Gazimağusa', name_en: 'Famagusta Old Town', name_tr: 'Gazimağusa Kaleiçi',
      address_en: 'Namık Kemal Square, opposite Lala Mustafa Paşa Mosque', address_tr: 'Namık Kemal Meydanı, Lala Mustafa Paşa Camii karşısı',
      desc_en: 'Explore the walled city, Othello Castle and the harbour without dragging a suitcase over the cobbles.',
      desc_tr: 'Surlarla çevrili şehri, Othello Kalesi\'ni ve limanı, arnavut kaldırımında bavul sürüklemeden gezin.',
      best_for_en: 'Sightseeing and university move days', best_for_tr: 'Şehir gezisi ve üniversite taşınma günleri',
      lat: 35.1250, lng: 33.9410, open_time: '07:30', close_time: '22:00', open_24h: 0, capacity: 70, step_free: 1, sort: 5 },
    { slug: 'bellapais', town: 'Girne', name_en: 'Bellapais Village', name_tr: 'Beylerbeyi (Bellapais)',
      address_en: 'Village square, below the abbey', address_tr: 'Köy meydanı, manastırın altı',
      desc_en: 'Weddings, abbey concerts and long lunches under the Tree of Idleness. Leave the overnight bags here.',
      desc_tr: 'Düğünler, manastır konserleri ve Tembellik Ağacı altında uzun öğle yemekleri. Gecelik çantaları buraya bırakın.',
      best_for_en: 'Weddings and events', best_for_tr: 'Düğün ve etkinlikler',
      lat: 35.3065, lng: 33.3549, open_time: '09:00', close_time: '23:00', open_24h: 0, capacity: 40, step_free: 0, sort: 6 },
    { slug: 'iskele-long-beach', town: 'İskele', name_en: 'İskele Long Beach', name_tr: 'İskele Long Beach',
      address_en: 'Promenade, beside the main beach entrance', address_tr: 'Sahil yürüyüş yolu, ana plaj girişinin yanı',
      desc_en: 'Checked out of your apartment but not ready to leave the beach? Bags with us, you in the sea.',
      desc_tr: 'Dairenizden çıkış yaptınız ama plajdan ayrılmaya hazır değil misiniz? Bavullar bizde, siz denizde.',
      best_for_en: 'Apartment checkouts and beach days', best_for_tr: 'Daire çıkışları ve plaj günleri',
      lat: 35.2830, lng: 33.9030, open_time: '08:00', close_time: '22:00', open_24h: 0, capacity: 60, step_free: 1, sort: 7 },
  ];
  L.forEach(r => loc.run(r));

  const tar = db.prepare(`INSERT INTO tariffs (code,name_en,name_tr,desc_en,desc_tr,unit_en,unit_tr,features_en,features_tr,mode,price,hours,min_days,max_days,max_bags,featured,sort)
    VALUES (@code,@name_en,@name_tr,@desc_en,@desc_tr,@unit_en,@unit_tr,@features_en,@features_tr,@mode,@price,@hours,@min_days,@max_days,@max_bags,@featured,@sort)`);
  [
    { code: 'quick', name_en: 'Quick Stop', name_tr: 'Kısa Mola', desc_en: 'A castle visit, a long lunch, a few hours before the ferry.', desc_tr: 'Bir kale gezisi, uzun bir öğle yemeği, feribottan önce birkaç saat.',
      unit_en: 'per bag, up to 4 hours', unit_tr: 'bavul başı, 4 saate kadar',
      features_en: 'Any size, any weight\n€1,000 insurance per bag\nPhoto log and tamper seal', features_tr: 'Her boyut, her ağırlık\nBavul başı €1.000 sigorta\nFotoğraf kaydı ve güvenlik mührü',
      mode: 'per_bag', price: 4, hours: 4, min_days: 1, max_days: 1, max_bags: 20, featured: 0, sort: 1 },
    { code: 'day', name_en: 'Day Drop', name_tr: 'Günlük', desc_en: 'Check out at 11, fly out at midnight.', desc_tr: 'Saat 11\'de çıkış, gece yarısı uçuş.',
      unit_en: 'per bag, up to 24 hours', unit_tr: 'bavul başı, 24 saate kadar',
      features_en: 'Everything in Quick Stop\nFree cancellation up to 1 hour before\nLate collection to 23:00 (24h at Ercan)', features_tr: 'Kısa Mola\'daki her şey\n1 saat öncesine kadar ücretsiz iptal\n23:00\'e kadar teslim alma (Ercan\'da 24 saat)',
      mode: 'per_bag', price: 6.5, hours: 24, min_days: 1, max_days: 1, max_bags: 20, featured: 1, sort: 2 },
    { code: 'multi', name_en: 'Multi-Day', name_tr: 'Çok Günlük', desc_en: 'Heading to Karpaz or across to Turkey for a few days.', desc_tr: 'Birkaç günlüğüne Karpaz\'a ya da Türkiye\'ye mi gidiyorsunuz?',
      unit_en: 'per bag, per day, from 2 days', unit_tr: 'bavul başı, günlük, en az 2 gün',
      features_en: 'Everything in Day Drop\nLower daily rate\nCollect from a different Point on request', features_tr: 'Günlük tarifedeki her şey\nDaha düşük günlük ücret\nİsteğe bağlı farklı noktadan teslim alma',
      mode: 'per_bag_day', price: 5, hours: 24, min_days: 2, max_days: 30, max_bags: 20, featured: 0, sort: 3 },
    { code: 'student', name_en: 'Student Locker', name_tr: 'Öğrenci Dolabı', desc_en: 'Summer break, exchange term, between flats.', desc_tr: 'Yaz tatili, değişim dönemi, ev arası dönemler.',
      unit_en: 'per month, up to 4 bags or boxes', unit_tr: 'aylık, 4 bavul veya koliye kadar',
      features_en: 'Dedicated shelf, not shared\nAccess any time we\'re open\nCancel any month', features_tr: 'Size ayrılmış raf, paylaşımlı değil\nAçık olduğumuz her saatte erişim\nİstediğiniz ay iptal',
      mode: 'flat', price: 45, hours: 720, min_days: 30, max_days: 30, max_bags: 4, featured: 0, sort: 4 },
  ].forEach(r => tar.run(r));

  const add = db.prepare(`INSERT INTO addons (code,name_en,name_tr,desc_en,desc_tr,price,per,sort) VALUES (@code,@name_en,@name_tr,@desc_en,@desc_tr,@price,@per,@sort)`);
  [
    { code: 'hotel_pickup', name_en: 'Hotel pickup', name_tr: 'Otelden alım', desc_en: 'We collect from your hotel reception in Kyrenia, Nicosia or Famagusta.', desc_tr: 'Girne, Lefkoşa veya Gazimağusa\'da otel resepsiyonunuzdan alırız.', price: 15, per: 'booking', sort: 1 },
    { code: 'airport_delivery', name_en: 'Airport delivery', name_tr: 'Havalimanına teslim', desc_en: 'Your bags meet you at Ercan departures.', desc_tr: 'Bavullarınız sizi Ercan dış hatlar gidişte karşılar.', price: 20, per: 'booking', sort: 2 },
    { code: 'premium_cover', name_en: 'Premium cover (€5,000)', name_tr: 'Premium sigorta (€5.000)', desc_en: 'For cameras, laptops and dive kit.', desc_tr: 'Kamera, dizüstü bilgisayar ve dalış ekipmanı için.', price: 3, per: 'bag', sort: 3 },
    { code: 'wrap', name_en: 'Wrap and protect', name_tr: 'Streçleme', desc_en: 'Film-wrapped and ready to check in.', desc_tr: 'Streç filmle sarılı, bagaja hazır.', price: 6, per: 'bag', sort: 4 },
    { code: 'after_hours', name_en: 'After-hours collection', name_tr: 'Mesai dışı teslim', desc_en: 'Collect up to 01:00 at harbour and town Points.', desc_tr: 'Liman ve şehir noktalarında 01:00\'e kadar teslim alma.', price: 15, per: 'booking', sort: 5 },
  ].forEach(r => add.run(r));

  const dt = db.prepare('INSERT INTO discount_tiers (min_bag_days, percent) VALUES (?,?)');
  [[3, 8], [6, 15], [12, 20]].forEach(r => dt.run(...r));

  const fq = db.prepare('INSERT INTO faqs (category,q_en,q_tr,a_en,a_tr,sort,featured) VALUES (?,?,?,?,?,?,?)');
  [
    ['booking', 'Do I need to book in advance?', 'Önceden rezervasyon yapmam gerekiyor mu?',
      'No, walk-ins are welcome whenever there\'s space. Booking online guarantees your spot and takes about a minute.',
      'Hayır, yer olduğu sürece rezervasyonsuz da gelebilirsiniz. Online rezervasyon yerinizi garantiler ve yaklaşık bir dakika sürer.', 1, 1],
    ['booking', 'How do I pay?', 'Nasıl ödeme yaparım?',
      'Pay at the desk by card or cash in euro, sterling or Turkish lira. The price is fixed when you book.',
      'Bankoda kartla ya da euro, sterlin veya Türk lirası nakit ödeyebilirsiniz. Fiyat rezervasyon anında sabitlenir.', 2, 1],
    ['bags', 'Is there a size or weight limit?', 'Boyut veya ağırlık sınırı var mı?',
      'No. Cabin bags, 32 kg cases, golf clubs, pushchairs and dive kit all cost the same per item.',
      'Hayır. Kabin bavulu, 32 kg valiz, golf çantası, bebek arabası veya dalış ekipmanı; hepsi parça başı aynı fiyattır.', 3, 1],
    ['bags', 'Are my bags insured?', 'Bavullarım sigortalı mı?',
      'Yes. Every bag is covered up to €1,000 as standard. Premium cover raises that to €5,000 for €3 per bag.',
      'Evet. Her bavul standart olarak €1.000\'e kadar sigortalıdır. Bavul başı €3 karşılığında Premium sigorta ile bu tutar €5.000\'e çıkar.', 4, 1],
    ['bags', 'What can\'t I leave?', 'Neleri bırakamam?',
      'Cash, passports, medication you need that day, perishable food, live animals, weapons and anything flammable.',
      'Nakit para, pasaport, o gün ihtiyaç duyacağınız ilaçlar, bozulabilir gıdalar, canlı hayvan, silah ve yanıcı maddeler.', 5, 0],
    ['booking', 'Can I cancel?', 'İptal edebilir miyim?',
      'Yes, free of charge up to one hour before your drop-off time. Use the link in your confirmation email.',
      'Evet, bırakma saatinizden bir saat öncesine kadar ücretsiz. Onay e-postanızdaki bağlantıyı kullanın.', 6, 1],
    ['travel', 'I\'m staying in the south. Can I use you on a day trip?', 'Güneyde kalıyorum. Günübirlik gezide sizi kullanabilir miyim?',
      'Yes. Our Nicosia Point is a short walk from the Lokmacı (Ledra Street) crossing. Remember to carry your passport or ID across with you.',
      'Evet. Lefkoşa noktamız Lokmacı (Ledra Sokağı) sınır kapısına kısa bir yürüyüş mesafesindedir. Geçişte pasaportunuzu veya kimliğinizi yanınızda taşımayı unutmayın.', 7, 0],
    ['travel', 'Do you open for late flights?', 'Geç uçuşlar için açık mısınız?',
      'Our Ercan Airport Point is open 24 hours. Town Points close at 22:00 or 23:00, and after-hours collection to 01:00 is available.',
      'Ercan Havalimanı noktamız 24 saat açıktır. Şehir noktaları 22:00 veya 23:00\'te kapanır; 01:00\'e kadar mesai dışı teslim alma hizmeti mevcuttur.', 8, 0],
    ['students', 'Can students store things over summer?', 'Öğrenciler yaz boyunca eşya bırakabilir mi?',
      'Yes. The Student Locker holds up to four bags or boxes on your own shelf for a flat monthly price. Bring your student card.',
      'Evet. Öğrenci Dolabı, size ait bir rafta dört bavul veya koliye kadar sabit aylık ücretle saklama sunar. Öğrenci kartınızı getirin.', 9, 0],
  ].forEach(r => fq.run(...r));

  const st = db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)');
  Object.entries({
    business_name: 'LuggagePark North Cyprus',
    currency: 'EUR', currency_symbol: '€',
    phone: '+90 548 000 00 00', whatsapp: '905480000000',
    email: 'hello@luggagepark.com', site_url: process.env.SITE_URL || 'http://localhost:3000',
    booking_notice_email: 'bookings@luggagepark.com',
    insurance_amount: '1000',
    instagram: '', facebook: '',
    maintenance_banner_en: '', maintenance_banner_tr: '',
  }).forEach(([k, v]) => st.run(k, v));

  // Owner account
  const email = (process.env.ADMIN_EMAIL || 'admin@luggagepark.com').toLowerCase();
  const pass = process.env.ADMIN_PASSWORD || 'ChangeMe!2026';
  db.prepare('INSERT INTO users (email,name,password_hash,role) VALUES (?,?,?,?)')
    .run(email, 'Owner', bcrypt.hashSync(pass, 12), 'owner');
  console.log(`[seed] owner account created: ${email}` + (process.env.ADMIN_PASSWORD ? '' : ' / ChangeMe!2026  (change it after first login)'));
}
seed();

// ---------- helpers ----------
const settingsCache = { data: null };
function settings() {
  if (!settingsCache.data) {
    settingsCache.data = Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value]));
  }
  return settingsCache.data;
}
function setSetting(k, v) {
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(k, v);
  settingsCache.data = null;
}
function audit(user, action, entity, entityId, detail) {
  db.prepare('INSERT INTO audit_log (user_id,user_name,action,entity,entity_id,detail) VALUES (?,?,?,?,?,?)')
    .run(user ? user.id : null, user ? user.name : 'website', action, entity || null, entityId != null ? String(entityId) : null,
      detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)) : null);
}

module.exports = { db, settings, setSetting, audit, settingsCache };
