require('dotenv').config();
const express = require('express');
const compression = require('compression');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE        = path.join(__dirname, 'data', 'articles.json');
const CATEGORIES_FILE  = path.join(__dirname, 'data', 'categories.json');
const UPLOADS_DIR      = path.join(__dirname, 'public', 'uploads');

const DEFAULT_CATEGORIES = ['Leadership', 'Executive Presence', 'Career Transitions', 'Mindset', 'Women in Leadership'];

// ─── Production guard ─────────────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  const missing = ['SESSION_SECRET', 'ADMIN_PASSWORD', 'SMTP_USER', 'SMTP_PASS'].filter(k => !process.env[k]);
  if (missing.length) throw new Error(`Missing required env vars: ${missing.join(', ')}`);
}

// Ensure directories and seed files exist
[path.join(__dirname, 'data'), UPLOADS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
if (!fs.existsSync(DATA_FILE))        fs.writeFileSync(DATA_FILE,        JSON.stringify({ articles: [] }, null, 2));
if (!fs.existsSync(CATEGORIES_FILE))  fs.writeFileSync(CATEGORIES_FILE,  JSON.stringify(DEFAULT_CATEGORIES, null, 2));

// ─── In-memory cache (invalidated on every write) ────────────────────────────
let _articlesCache = null;
let _categoriesCache = null;

function readArticles() {
  if (_articlesCache) return _articlesCache;
  try { _articlesCache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).articles || []; }
  catch { _articlesCache = []; }
  return _articlesCache;
}

function writeArticles(articles) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ articles }, null, 2));
  _articlesCache = articles;
}

// ─── Category helpers ─────────────────────────────────────────────────────────
function readCategories() {
  if (_categoriesCache) return _categoriesCache;
  try { _categoriesCache = JSON.parse(fs.readFileSync(CATEGORIES_FILE, 'utf8')); }
  catch { _categoriesCache = [...DEFAULT_CATEGORIES]; }
  return _categoriesCache;
}

function resolveCategory(body) {
  if (body.category === '__new__') {
    const cat = (body.new_category || '').trim();
    if (cat) {
      const cats = readCategories();
      if (!cats.includes(cat)) {
        cats.push(cat);
        fs.writeFileSync(CATEGORIES_FILE, JSON.stringify(cats, null, 2));
        _categoriesCache = cats;
      }
      return cat;
    }
  }
  return body.category || 'Leadership';
}

function slugify(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').trim();
}

// ─── HTML escaping for email bodies ──────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Session-based CSRF ───────────────────────────────────────────────────────
function generateCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

function requireCsrf(req, res, next) {
  const token = req.body._csrf;
  if (!token || token !== req.session.csrfToken) {
    return res.status(403).send('Request blocked: invalid CSRF token.');
  }
  next();
}

// ─── Login rate limiter (in-memory) ──────────────────────────────────────────
const loginAttempts = new Map();
const LOGIN_MAX = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

// ─── Contact form rate limiter (3 per hour per IP) ───────────────────────────
const contactAttempts = new Map();
const CONTACT_MAX = 3;
const CONTACT_WINDOW_MS = 60 * 60 * 1000;

function checkContactRateLimit(ip) {
  const now = Date.now();
  const entry = contactAttempts.get(ip);
  if (!entry || now - entry.windowStart > CONTACT_WINDOW_MS) {
    contactAttempts.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= CONTACT_MAX) return false;
  entry.count++;
  return true;
}

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= LOGIN_MAX) return false;
  entry.count++;
  return true;
}

function resetLoginRateLimit(ip) {
  loginAttempts.delete(ip);
}

// ─── Multer ───────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // SVG excluded — SVG files can contain embedded scripts
    if (/^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG, GIF, and WebP images are allowed'));
  }
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(compression());
// Immutable assets (hashed filenames) get 1-year cache; everything else 1 day
app.use('/css', express.static(path.join(__dirname, 'public', 'css'), { maxAge: '7d' }));
app.use('/js', express.static(path.join(__dirname, 'public', 'js'), { maxAge: '7d' }));
app.use('/images', express.static(path.join(__dirname, 'public', 'images'), { maxAge: '30d' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'rysen-admin-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production'
  }
}));

const siteUrl = process.env.SITE_URL || `http://localhost:${PORT}`;

// ─── Admin auth guard ─────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.redirect('/admin/login');
}

// ─── Public pages ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.render('index', {
    title: 'RYSEN Coaching | Executive Coach Bidisha Banerjee',
    description: 'ICF PCC-Certified Executive Coach helping mid-senior leaders navigate career transitions, build executive presence, and lead with clarity.',
    ogImage: `${siteUrl}/images/bidisha-portrait-hero.png`,
    canonicalUrl: siteUrl,
    page: 'home'
  });
});

app.get('/about', (req, res) => {
  res.render('about', {
    title: 'About Bidisha Banerjee | ICF PCC Executive Coach',
    description: '25+ years as CHRO and CLO. Now coaching leaders across Google, PayPal, DHL, IKEA and Fortune 500 organisations worldwide.',
    ogImage: `${siteUrl}/images/bidisha-portrait-hero.png`,
    canonicalUrl: `${siteUrl}/about`,
    page: 'about'
  });
});

app.get('/services', (req, res) => {
  res.render('services', {
    title: 'Coaching Programs | RYSEN Coaching',
    description: 'Executive coaching programs from Discovery Session to flagship Rise to Your Next Level.',
    ogImage: `${siteUrl}/images/bidisha-portrait-hero.png`,
    canonicalUrl: `${siteUrl}/services`,
    page: 'services'
  });
});

app.get('/book-speaking', (req, res) => {
  res.render('book-speaking', {
    title: 'Book Bidisha | Speaking & Published Work | RYSEN Coaching',
    description: "Keynote speaker on leadership, executive presence, and women in leadership. Author of 'Your Turn to Rise'.",
    ogImage: `${siteUrl}/images/bidisha-portrait-hero.png`,
    canonicalUrl: `${siteUrl}/book-speaking`,
    page: 'book-speaking'
  });
});

app.get('/contact', (req, res) => {
  res.render('contact', {
    title: 'Contact Bidisha | RYSEN Coaching',
    description: 'Get in touch to explore coaching programs, speaking engagements, or organisational leadership interventions.',
    ogImage: `${siteUrl}/images/bidisha-portrait-hero.png`,
    canonicalUrl: `${siteUrl}/contact`,
    page: 'contact'
  });
});

// ─── Resources (dynamic articles) ────────────────────────────────────────────
app.get('/resources', (req, res) => {
  const allArticles = readArticles().filter(a => a.published);
  const activeCategory = req.query.category || 'all';
  const articles = activeCategory === 'all'
    ? allArticles
    : allArticles.filter(a => a.category === activeCategory);
  const usedCategories = [...new Set(allArticles.map(a => a.category))];

  res.render('resources', {
    title: 'Resources | Leadership Insights | RYSEN Coaching',
    description: 'Articles, insights, and tools for mid-senior leaders navigating career transitions and leadership growth.',
    ogImage: `${siteUrl}/images/bidisha-portrait-hero.png`,
    canonicalUrl: `${siteUrl}/resources`,
    page: 'resources',
    articles,
    usedCategories,
    activeCategory
  });
});

// ─── Single blog post ─────────────────────────────────────────────────────────
app.get('/blog/:slug', (req, res) => {
  const allArticles = readArticles();
  const article = allArticles.find(a => a.slug === req.params.slug && a.published);
  if (!article) {
    return res.status(404).render('404', {
      title: 'Page Not Found | RYSEN Coaching',
      description: 'The page you are looking for could not be found.',
      ogImage: `${siteUrl}/images/bidisha-portrait-hero.png`,
      canonicalUrl: `${siteUrl}/404`,
      page: 'resources'
    });
  }
  const related = allArticles
    .filter(a => a.published && a.id !== article.id && a.category === article.category)
    .slice(0, 3);

  res.render('blog-post', {
    title: article.seoTitle || `${article.title} | RYSEN Coaching`,
    description: article.seoDescription || article.excerpt,
    ogImage: article.ogImage || article.featuredImage || `${siteUrl}/images/bidisha-portrait-hero.png`,
    canonicalUrl: `${siteUrl}/blog/${article.slug}`,
    page: 'resources',
    article,
    related,
    siteUrl
  });
});

// ─── Admin login ──────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => res.redirect('/admin/dashboard'));

app.get('/admin/login', (req, res) => {
  if (req.session.isAdmin) return res.redirect('/admin/dashboard');
  res.render('admin/login', { error: null });
});

app.post('/admin/login', (req, res) => {
  if (!checkLoginRateLimit(req.ip)) {
    return res.render('admin/login', { error: 'Too many login attempts. Please try again in 15 minutes.' });
  }
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD || 'rysen2024';
  if (password === adminPassword) {
    resetLoginRateLimit(req.ip);
    req.session.isAdmin = true;
    res.redirect('/admin/dashboard');
  } else {
    res.render('admin/login', { error: 'Incorrect password. Please try again.' });
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// ─── Admin dashboard ──────────────────────────────────────────────────────────
app.get('/admin/dashboard', requireAdmin, (req, res) => {
  const articles = readArticles();
  res.render('admin/dashboard', {
    articles,
    message: req.query.message || null,
    csrfToken: generateCsrfToken(req)
  });
});

// ─── New article ──────────────────────────────────────────────────────────────
app.get('/admin/new', requireAdmin, (req, res) => {
  res.render('admin/article-form', {
    article: null,
    action: '/admin/new',
    error: null,
    categories: readCategories(),
    csrfToken: generateCsrfToken(req)
  });
});

app.post('/admin/new', requireAdmin, requireCsrf, (req, res) => {
  const { title, excerpt, content, featuredImage, readTime, published, seoTitle, seoDescription, ogImage } = req.body;

  if (!title || !title.trim()) {
    return res.render('admin/article-form', {
      article: req.body, action: '/admin/new',
      error: 'Title is required.', categories: readCategories(),
      csrfToken: generateCsrfToken(req)
    });
  }

  const category = resolveCategory(req.body);
  const articles = readArticles();
  let slug = slugify(title);
  let counter = 1;
  while (articles.find(a => a.slug === slug)) {
    slug = `${slugify(title)}-${counter++}`;
  }

  const newArticle = {
    id: crypto.randomUUID(),
    title: title.trim(),
    slug,
    category,
    excerpt: (excerpt || '').trim(),
    content: content || '',
    featuredImage: (featuredImage || '').trim(),
    readTime: readTime || '5',
    author: 'Bidisha Banerjee',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    published: published === 'on',
    seoTitle: (seoTitle || title).trim(),
    seoDescription: (seoDescription || excerpt || '').trim(),
    ogImage: (ogImage || featuredImage || '').trim()
  };

  articles.unshift(newArticle);
  writeArticles(articles);
  res.redirect('/admin/dashboard?message=Article+created+successfully');
});

// ─── Edit article ─────────────────────────────────────────────────────────────
app.get('/admin/edit/:id', requireAdmin, (req, res) => {
  const article = readArticles().find(a => a.id === req.params.id);
  if (!article) return res.redirect('/admin/dashboard?message=Article+not+found');
  res.render('admin/article-form', {
    article,
    action: `/admin/edit/${article.id}`,
    error: null,
    categories: readCategories(),
    csrfToken: generateCsrfToken(req)
  });
});

app.post('/admin/edit/:id', requireAdmin, requireCsrf, (req, res) => {
  const { title, excerpt, content, featuredImage, readTime, published, seoTitle, seoDescription, ogImage } = req.body;

  if (!title || !title.trim()) {
    const existing = readArticles().find(a => a.id === req.params.id) || {};
    return res.render('admin/article-form', {
      article: { ...existing, ...req.body },
      action: `/admin/edit/${req.params.id}`,
      error: 'Title is required.',
      categories: readCategories(),
      csrfToken: generateCsrfToken(req)
    });
  }

  const articles = readArticles();
  const idx = articles.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.redirect('/admin/dashboard?message=Article+not+found');

  const category = resolveCategory(req.body);
  articles[idx] = {
    ...articles[idx],
    title: title.trim(),
    category,
    excerpt: (excerpt || '').trim(),
    content: content || '',
    featuredImage: (featuredImage || '').trim(),
    readTime: readTime || '5',
    updatedAt: new Date().toISOString(),
    published: published === 'on',
    seoTitle: (seoTitle || title).trim(),
    seoDescription: (seoDescription || excerpt || '').trim(),
    ogImage: (ogImage || featuredImage || '').trim()
  };

  writeArticles(articles);
  res.redirect('/admin/dashboard?message=Article+updated+successfully');
});

// ─── Delete article ───────────────────────────────────────────────────────────
app.post('/admin/delete/:id', requireAdmin, requireCsrf, (req, res) => {
  writeArticles(readArticles().filter(a => a.id !== req.params.id));
  res.redirect('/admin/dashboard?message=Article+deleted');
});

// ─── Image upload (Quill editor) ──────────────────────────────────────────────
app.post('/api/upload', requireAdmin, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

// ─── Contact form ─────────────────────────────────────────────────────────────
app.post('/contact', async (req, res) => {
  // Honeypot — bots fill hidden field, humans don't
  if (req.body.company_website) {
    return res.json({ success: true });
  }

  // Rate limit — max 3 submissions per IP per hour
  if (!checkContactRateLimit(req.ip)) {
    return res.status(429).json({ success: false, error: 'Too many submissions. Please try again later.' });
  }

  const { name, email, message } = req.body;
  const linkedin = (req.body.linkedin || '').trim();

  if (!name || !email || !message) {
    return res.status(400).json({ success: false, error: 'Please fill in all required fields.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
  }
  if (linkedin) {
    try {
      const parsed = new URL(linkedin);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error();
    } catch {
      return res.status(400).json({ success: false, error: 'Please enter a valid LinkedIn URL.' });
    }
  }

  const safeName     = escapeHtml(name);
  const safeEmail    = escapeHtml(email);
  const safeLinkedin = escapeHtml(linkedin);
  const safeMessage  = escapeHtml(message);

  const leadHtml = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#FAFAF8;">
        <h2 style="font-family:Georgia,serif;color:#1A1A1A;margin-bottom:24px;">New Coaching Enquiry</h2>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:12px 0;border-bottom:1px solid #E8E4DC;color:#6B6B6B;width:140px;font-weight:600;">Name</td><td style="padding:12px 0;border-bottom:1px solid #E8E4DC;color:#1A1A1A;">${safeName}</td></tr>
          <tr><td style="padding:12px 0;border-bottom:1px solid #E8E4DC;color:#6B6B6B;font-weight:600;">Email</td><td style="padding:12px 0;border-bottom:1px solid #E8E4DC;"><a href="mailto:${safeEmail}" style="color:#F97316;">${safeEmail}</a></td></tr>
          ${safeLinkedin ? `<tr><td style="padding:12px 0;border-bottom:1px solid #E8E4DC;color:#6B6B6B;font-weight:600;">LinkedIn</td><td style="padding:12px 0;border-bottom:1px solid #E8E4DC;"><a href="${safeLinkedin}" style="color:#F97316;">${safeLinkedin}</a></td></tr>` : ''}
          <tr><td style="padding:12px 0;color:#6B6B6B;font-weight:600;vertical-align:top;">Message</td><td style="padding:12px 0;color:#1A1A1A;white-space:pre-line;">${safeMessage}</td></tr>
        </table>
      </div>`;

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 465,
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });

    await transporter.sendMail({
      from: `"RYSEN Coaching" <info@ampwake.com>`,
      replyTo: email,
      to: 'bidisha@rysencoaching.com',
      subject: `New Coaching Enquiry from ${safeName}`,
      html: leadHtml
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Email send error:', err);
    res.status(500).json({ success: false, error: 'Failed to send message. Please try again or email directly.' });
  }
});

// ─── Legal pages ──────────────────────────────────────────────────────────────
app.get('/privacy-policy', (req, res) => {
  res.render('privacy-policy', {
    title: 'Privacy Policy | RYSEN Coaching',
    description: 'How RYSEN Coaching collects, uses, and protects your personal information.',
    ogImage: `${siteUrl}/images/bidisha-portrait-hero.png`,
    canonicalUrl: `${siteUrl}/privacy-policy`,
    page: 'legal'
  });
});

app.get('/terms-of-service', (req, res) => {
  res.render('terms-of-service', {
    title: 'Terms of Service | RYSEN Coaching',
    description: 'Terms and conditions governing your use of RYSEN Coaching services.',
    ogImage: `${siteUrl}/images/bidisha-portrait-hero.png`,
    canonicalUrl: `${siteUrl}/terms-of-service`,
    page: 'legal'
  });
});

// ─── Sitemap ──────────────────────────────────────────────────────────────────
app.get('/sitemap.xml', (req, res) => {
  const articles = readArticles().filter(a => a.published);
  const staticUrls = [
    { loc: siteUrl, priority: '1.0', changefreq: 'weekly' },
    { loc: `${siteUrl}/about`, priority: '0.9', changefreq: 'monthly' },
    { loc: `${siteUrl}/services`, priority: '0.9', changefreq: 'monthly' },
    { loc: `${siteUrl}/resources`, priority: '0.8', changefreq: 'weekly' },
    { loc: `${siteUrl}/book-speaking`, priority: '0.7', changefreq: 'monthly' },
    { loc: `${siteUrl}/contact`, priority: '0.7', changefreq: 'monthly' }
  ];
  const articleUrls = articles.map(a => ({
    loc: `${siteUrl}/resources/${a.slug}`,
    lastmod: new Date(a.updatedAt || a.createdAt).toISOString().split('T')[0],
    priority: '0.6',
    changefreq: 'monthly'
  }));
  const allUrls = [...staticUrls, ...articleUrls];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${allUrls.map(u => `  <url>
    <loc>${u.loc}</loc>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ''}
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;
  res.set('Content-Type', 'application/xml');
  res.send(xml);
});

// ─── 404 fallback ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).render('404', {
    title: 'Page Not Found | RYSEN Coaching',
    description: 'The page you are looking for could not be found.',
    ogImage: `${siteUrl}/images/bidisha-portrait-hero.png`,
    canonicalUrl: `${siteUrl}`,
    page: 'home'
  });
});

// ─── Error handler ────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large. Maximum size is 5 MB.' });
  }
  if (err.message === 'Only JPEG, PNG, GIF, and WebP images are allowed') {
    return res.status(415).json({ error: err.message });
  }
  console.error(err);
  res.status(500).send('Internal server error.');
});

app.listen(PORT, () => {
  console.log(`RYSEN Coaching server running at http://localhost:${PORT}`);
});
