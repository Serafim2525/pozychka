// ПозичКа — сервер (Express + SQLite).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcrypt');
const QRCode = require('qrcode');
const {
  db, CATEGORIES, DAY, nowIso, isoIn, generateCode, recalcKarma, applyOverduePenalties, seed,
} = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const QR_LIB = path.join(__dirname, 'node_modules', 'html5-qrcode', 'html5-qrcode.min.js');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (seed()) console.log('✔ Базу даних створено та заповнено демо-даними');
applyOverduePenalties();

const app = express();
app.disable('x-powered-by');

// Базові заголовки безпеки. CSP забороняє inline-скрипти, тож XSS через вставлений <script> не спрацює.
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; " +
      "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  });
  next();
});

app.use(express.json({ limit: '20kb' }));
app.use(
  session({
    name: 'pozychka.sid',
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === '1', maxAge: 7 * DAY },
  })
);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR, { dotfiles: 'deny', index: false }));
app.get('/vendor/html5-qrcode.min.js', (req, res) => res.sendFile(QR_LIB));

// ---------- Допоміжні функції ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

function text(value, { field, min = 0, max }) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (v.length < min) fail(400, min > 1 ? `Поле «${field}» занадто коротке` : `Заповніть поле «${field}»`);
  if (v.length > max) fail(400, `Поле «${field}» занадто довге (макс. ${max} символів)`);
  return v;
}

function intId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) fail(400, 'Некоректний ідентифікатор');
  return n;
}

const EMAIL_RE = /^[a-z0-9._%+-]+@school\.ua$/i;
const CLASS_RE = /^(5|6|7|8|9|10|11)-[АБВГ]$/;

const publicUser = (u) => ({
  id: u.id, name: u.name, class: u.class, email: u.email, role: u.role, karma: u.karma,
});

// ---------- Автентифікація та ролі ----------

let lastOverdueCheck = Date.now();
app.use('/api', (req, res, next) => {
  if (Date.now() - lastOverdueCheck > 60 * 1000) {
    lastOverdueCheck = Date.now();
    applyOverduePenalties();
  }
  req.user = null;
  if (!req.session.userId) return next();
  const u = db
    .prepare('SELECT id, name, class, email, role, karma, is_blocked FROM users WHERE id = ?')
    .get(req.session.userId);
  if (!u || u.is_blocked) {
    req.blocked = Boolean(u && u.is_blocked);
    return req.session.destroy(() => next());
  }
  req.user = u;
  next();
});

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      error: req.blocked ? 'Ваш акаунт заблоковано. Зверніться до адміністратора.' : 'Потрібно увійти',
    });
  }
  next();
}

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Потрібно увійти' });
  if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Недостатньо прав' });
  next();
};

// Обгортка, щоб помилки з обробників потрапляли в загальний обробник.
const h = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res, next);
    if (out && typeof out.catch === 'function') out.catch(next);
  } catch (e) {
    next(e);
  }
};

function startSession(req, user) {
  return new Promise((resolve, reject) => {
    // Нова сесія після входу — захист від фіксації сесії.
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = user.id;
      req.session.save((e) => (e ? reject(e) : resolve()));
    });
  });
}

app.post('/api/auth/register', h(async (req, res) => {
  const name = text(req.body.name, { field: "Ім'я", min: 2, max: 60 });
  const cls = text(req.body.class, { field: 'Клас', min: 1, max: 5 });
  const email = text(req.body.email, { field: 'Пошта', min: 1, max: 100 }).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!EMAIL_RE.test(email)) fail(400, 'Реєстрація можлива лише зі шкільною поштою @school.ua');
  if (!CLASS_RE.test(cls)) fail(400, 'Оберіть клас зі списку');
  if (password.length < 6) fail(400, 'Пароль має містити щонайменше 6 символів');
  if (password.length > 100) fail(400, 'Пароль занадто довгий');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) fail(409, 'Користувач із такою поштою вже існує');

  const hash = await bcrypt.hash(password, 10);
  const id = db
    .prepare("INSERT INTO users (name, class, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'student', ?)")
    .run(name, cls, email, hash, nowIso()).lastInsertRowid;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  await startSession(req, user);
  res.status(201).json({ user: publicUser(user) });
}));

app.post('/api/auth/login', h(async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const ok = user ? await bcrypt.compare(password, user.password_hash) : false;
  if (!ok) fail(401, 'Невірна пошта або пароль');
  if (user.is_blocked) fail(403, 'Ваш акаунт заблоковано. Зверніться до адміністратора.');
  await startSession(req, user);
  res.json({ user: publicUser(user) });
}));

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('pozychka.sid');
    res.json({ ok: true });
  });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null, blocked: Boolean(req.blocked) });
});

// ---------- Сповіщення ----------

function notificationsFor(userId) {
  const requests = db
    .prepare(
      `SELECT COUNT(*) AS n FROM loans l JOIN items i ON i.id = l.item_id
       WHERE i.owner_id = ? AND l.status = 'requested' AND i.is_deleted = 0`
    )
    .get(userId).n;
  const messages = db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages m
       JOIN loans l ON l.id = m.loan_id JOIN items i ON i.id = l.item_id
       WHERE m.is_read = 0 AND m.sender_id != ? AND (l.borrower_id = ? OR i.owner_id = ?)`
    )
    .get(userId, userId, userId).n;
  return { requests, messages, total: requests + messages };
}

app.get('/api/notifications', requireAuth, (req, res) => res.json(notificationsFor(req.user.id)));

// ---------- Речі ----------

const PHOTO_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + PHOTO_TYPES[file.mimetype]),
  }),
  limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 10, fieldSize: 2000 },
  fileFilter: (req, file, cb) =>
    PHOTO_TYPES[file.mimetype] ? cb(null, true) : cb(new HttpError(400, 'Дозволені лише фото JPG, PNG, WEBP або GIF')),
});

// Перевіряємо «магічні байти», щоб під виглядом картинки не завантажили інший файл.
function looksLikeImage(file) {
  const buf = Buffer.alloc(12);
  const fd = fs.openSync(file.path, 'r');
  try {
    fs.readSync(fd, buf, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }
  switch (file.mimetype) {
    case 'image/jpeg': return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case 'image/png': return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/gif': return buf.subarray(0, 4).toString('latin1') === 'GIF8';
    case 'image/webp': return buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
    default: return false;
  }
}

const ITEM_SELECT = `
  SELECT i.id, i.owner_id, i.title, i.category, i.description, i.photo, i.location, i.max_days,
         i.is_available, i.created_at,
         u.name AS owner_name, u.class AS owner_class, u.karma AS owner_karma`;

app.get('/api/items', requireAuth, (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLocaleLowerCase('uk-UA').slice(0, 60) : '';
  const category = CATEGORIES.includes(req.query.category) ? req.query.category : '';
  const cls = typeof req.query.class === 'string' && CLASS_RE.test(req.query.class) ? req.query.class : '';
  const onlyAvailable = req.query.available === '1';
  const items = db
    .prepare(
      `${ITEM_SELECT},
         EXISTS (SELECT 1 FROM loans l WHERE l.item_id = i.id AND l.borrower_id = @me
                 AND l.status IN ('requested', 'approved', 'given')) AS my_request
       FROM items i JOIN users u ON u.id = i.owner_id
       WHERE i.is_deleted = 0 AND u.is_blocked = 0
         AND (@q = '' OR instr(ulower(i.title), @q) > 0 OR instr(ulower(i.description), @q) > 0)
         AND (@category = '' OR i.category = @category)
         AND (@cls = '' OR u.class = @cls)
         AND (@onlyAvailable = 0 OR i.is_available = 1)
       ORDER BY i.is_available DESC, u.karma DESC, i.created_at DESC
       LIMIT 200`
    )
    .all({ me: req.user.id, q, category, cls, onlyAvailable: onlyAvailable ? 1 : 0 });
  res.json({ items });
});

app.post('/api/items', requireAuth, (req, res, next) => {
  upload.single('photo')(req, res, (err) => {
    const cleanup = () => req.file && fs.unlink(req.file.path, () => {});
    try {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') fail(400, 'Фото завелике — максимум 2 МБ');
        if (err instanceof multer.MulterError) fail(400, 'Некоректне завантаження файлу');
        throw err;
      }
      const title = text(req.body.title, { field: 'Назва', min: 2, max: 80 });
      const category = req.body.category;
      if (!CATEGORIES.includes(category)) fail(400, 'Оберіть категорію');
      const description = text(req.body.description, { field: 'Опис', max: 500 });
      const location = text(req.body.location, { field: 'Місце', min: 1, max: 60 });
      const maxDays = Number(req.body.max_days);
      if (!Number.isInteger(maxDays) || maxDays < 1 || maxDays > 30) fail(400, 'Термін позики — від 1 до 30 днів');
      if (req.file && !looksLikeImage(req.file)) fail(400, 'Файл не схожий на зображення');

      const id = db
        .prepare(
          `INSERT INTO items (owner_id, title, category, description, photo, location, max_days, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(req.user.id, title, category, description, req.file ? req.file.filename : null, location, maxDays, nowIso())
        .lastInsertRowid;
      res.status(201).json({ id });
    } catch (e) {
      cleanup();
      next(e);
    }
  });
});

app.delete('/api/items/:id', requireAuth, h((req, res) => {
  const id = intId(req.params.id);
  const item = db.prepare('SELECT * FROM items WHERE id = ? AND is_deleted = 0').get(id);
  if (!item) fail(404, 'Річ не знайдено');
  const isAdmin = req.user.role === 'admin';
  if (item.owner_id !== req.user.id && !isAdmin) fail(403, 'Можна видаляти лише свої речі');
  const busy = db.prepare("SELECT 1 FROM loans WHERE item_id = ? AND status IN ('approved', 'given')").get(id);
  if (busy && !isAdmin) fail(409, 'Річ зараз у позиці — видалити можна після повернення');
  db.transaction(() => {
    // М'яке видалення: історія позик і відгуки (а отже й карма) зберігаються.
    db.prepare('UPDATE items SET is_deleted = 1, is_available = 0 WHERE id = ?').run(id);
    db.prepare("UPDATE loans SET status = 'rejected', qr_code = NULL WHERE item_id = ? AND status IN ('requested', 'approved')").run(id);
  })();
  res.json({ ok: true });
}));

// ---------- Позики ----------

const LOAN_SELECT = `
  SELECT l.id, l.item_id, l.borrower_id, l.status, l.created_at, l.due_date, l.given_at, l.returned_at, l.penalized,
         i.title AS item_title, i.category AS item_category, i.photo AS item_photo, i.location AS item_location,
         i.max_days AS item_max_days, i.owner_id,
         o.name AS owner_name, o.class AS owner_class, o.karma AS owner_karma,
         b.name AS borrower_name, b.class AS borrower_class, b.karma AS borrower_karma
  FROM loans l
  JOIN items i ON i.id = l.item_id
  JOIN users o ON o.id = i.owner_id
  JOIN users b ON b.id = l.borrower_id`;

const UNREAD_SQL = '(SELECT COUNT(*) FROM messages m WHERE m.loan_id = l.id AND m.is_read = 0 AND m.sender_id != @me)';

const qrImage = (code) => QRCode.toDataURL(`POZYCHKA:${code}`, { margin: 1, width: 280, color: { dark: '#1e1b3a' } });

function getLoanFor(req, id) {
  const loan = db.prepare(`${LOAN_SELECT} WHERE l.id = ?`).get(id);
  if (!loan) fail(404, 'Позику не знайдено');
  const me = req.user.id;
  if (loan.borrower_id !== me && loan.owner_id !== me && req.user.role !== 'admin') fail(403, 'Немає доступу до цієї позики');
  return loan;
}

app.post('/api/loans', requireAuth, h((req, res) => {
  const itemId = intId(req.body.item_id);
  const item = db
    .prepare('SELECT i.*, u.is_blocked AS owner_blocked FROM items i JOIN users u ON u.id = i.owner_id WHERE i.id = ?')
    .get(itemId);
  if (!item || item.is_deleted || item.owner_blocked) fail(404, 'Річ не знайдено');
  if (item.owner_id === req.user.id) fail(400, 'Це твоя власна річ 🙂');
  if (!item.is_available) fail(409, 'Річ зараз зайнята');
  const dup = db
    .prepare("SELECT 1 FROM loans WHERE item_id = ? AND borrower_id = ? AND status IN ('requested', 'approved', 'given')")
    .get(itemId, req.user.id);
  if (dup) fail(409, 'Ти вже надіслав запит на цю річ');
  const id = db
    .prepare("INSERT INTO loans (item_id, borrower_id, status, created_at) VALUES (?, ?, 'requested', ?)")
    .run(itemId, req.user.id, nowIso()).lastInsertRowid;
  res.status(201).json({ id });
}));

// Позики, де я позичальник.
app.get('/api/loans/borrowed', requireAuth, h(async (req, res) => {
  const loans = db
    .prepare(`${LOAN_SELECT.replace('SELECT', `SELECT ${UNREAD_SQL} AS unread, l.qr_code,`)}
              WHERE l.borrower_id = @me ORDER BY l.created_at DESC LIMIT 100`)
    .all({ me: req.user.id });
  for (const l of loans) {
    l.qr_image = ['approved', 'given'].includes(l.status) && l.qr_code ? await qrImage(l.qr_code) : null;
    if (!l.qr_image) l.qr_code = null;
  }
  res.json({ loans });
}));

// Позики моїх речей (вхідні запити, видані речі, історія).
app.get('/api/loans/lent', requireAuth, (req, res) => {
  const loans = db
    .prepare(`${LOAN_SELECT.replace('SELECT', `SELECT ${UNREAD_SQL} AS unread,`)}
              WHERE i.owner_id = @me ORDER BY l.created_at DESC LIMIT 100`)
    .all({ me: req.user.id });
  res.json({ loans });
});

app.get('/api/loans/:id',requireAuth, h(async (req, res) => {
  const id = intId(req.params.id);
  const loan = getLoanFor(req, id);
  const me = req.user.id;
  const raw = db.prepare('SELECT qr_code FROM loans WHERE id = ?').get(id);
  if (loan.borrower_id === me && ['approved', 'given'].includes(loan.status) && raw.qr_code) {
    loan.qr_code = raw.qr_code;
    loan.qr_image = await qrImage(raw.qr_code);
  }
  const reviews = db
    .prepare(
      `SELECT r.id, r.author_id, r.target_id, r.rating, r.comment, r.created_at, u.name AS author_name
       FROM reviews r JOIN users u ON u.id = r.author_id WHERE r.loan_id = ?`
    )
    .all(id);
  const isParticipant = loan.borrower_id === me || loan.owner_id === me;
  loan.role = loan.borrower_id === me ? 'borrower' : loan.owner_id === me ? 'owner' : 'viewer';
  loan.reviews = reviews;
  loan.can_review = isParticipant && loan.status === 'returned' && !reviews.some((r) => r.author_id === me);
  res.json({ loan });
}));

function ownerLoan(req, statuses) {
  const loan = getLoanFor(req, intId(req.params.id));
  if (loan.owner_id !== req.user.id) fail(403, 'Лише власник речі може це зробити');
  if (!statuses.includes(loan.status)) fail(409, 'Статус позики вже змінився — онови сторінку');
  return loan;
}

app.post('/api/loans/:id/approve', requireAuth, h((req, res) => {
  const loan = ownerLoan(req, ['requested']);
  const item = db.prepare('SELECT is_available, is_deleted FROM items WHERE id = ?').get(loan.item_id);
  if (!item.is_available || item.is_deleted) fail(409, 'Річ уже зайнята іншою позикою');
  db.transaction(() => {
    db.prepare("UPDATE loans SET status = 'approved', qr_code = ? WHERE id = ?").run(generateCode(), loan.id);
    db.prepare('UPDATE items SET is_available = 0 WHERE id = ?').run(loan.item_id);
    // Інші запити на цю ж річ автоматично відхиляються.
    db.prepare("UPDATE loans SET status = 'rejected' WHERE item_id = ? AND status = 'requested' AND id != ?").run(loan.item_id, loan.id);
  })();
  res.json({ ok: true });
}));

app.post('/api/loans/:id/reject', requireAuth, h((req, res) => {
  const loan = ownerLoan(req, ['requested', 'approved']);
  db.transaction(() => {
    db.prepare("UPDATE loans SET status = 'rejected', qr_code = NULL WHERE id = ?").run(loan.id);
    if (loan.status === 'approved') {
      db.prepare('UPDATE items SET is_available = 1 WHERE id = ? AND is_deleted = 0').run(loan.item_id);
    }
  })();
  res.json({ ok: true });
}));

app.post('/api/loans/:id/cancel', requireAuth, h((req, res) => {
  const loan = getLoanFor(req, intId(req.params.id));
  if (loan.borrower_id !== req.user.id) fail(403, 'Скасувати може лише той, хто надіслав запит');
  if (!['requested', 'approved'].includes(loan.status)) fail(409, 'Цю позику вже не можна скасувати');
  db.transaction(() => {
    db.prepare("UPDATE loans SET status = 'rejected', qr_code = NULL WHERE id = ?").run(loan.id);
    if (loan.status === 'approved') {
      db.prepare('UPDATE items SET is_available = 1 WHERE id = ? AND is_deleted = 0').run(loan.item_id);
    }
  })();
  res.json({ ok: true });
}));

// QR-передача: власник сканує код позичальника. approved → given, given → returned.
app.post('/api/qr/scan', requireAuth, h((req, res) => {
  const code = String(req.body.code || '')
    .toUpperCase()
    .replace(/^POZYCHKA:/, '')
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 20);
  if (code.length < 6) fail(400, 'Введіть код із QR (8 символів)');
  const loan = db
    .prepare(
      `SELECT l.*, i.owner_id, i.max_days, i.title FROM loans l JOIN items i ON i.id = l.item_id
       WHERE l.qr_code = ? AND l.status IN ('approved', 'given')`
    )
    .get(code);
  if (!loan) fail(404, 'Код не знайдено або він уже використаний');
  if (loan.owner_id !== req.user.id) fail(403, 'Цей код має сканувати власник речі');

  if (loan.status === 'approved') {
    const due = isoIn(loan.max_days * DAY);
    // Після видачі генеруємо новий код — він знадобиться для повернення.
    db.prepare("UPDATE loans SET status = 'given', given_at = ?, due_date = ?, qr_code = ? WHERE id = ?")
      .run(nowIso(), due, generateCode(), loan.id);
    return res.json({ loan_id: loan.id, status: 'given', due_date: due, message: `«${loan.title}» видано! Статус: «видано»` });
  }

  const late = loan.due_date && loan.due_date < nowIso();
  db.transaction(() => {
    db.prepare("UPDATE loans SET status = 'returned', returned_at = ?, qr_code = NULL WHERE id = ?").run(nowIso(), loan.id);
    db.prepare('UPDATE items SET is_available = 1 WHERE id = ? AND is_deleted = 0').run(loan.item_id);
    if (late && !loan.penalized) {
      db.prepare('UPDATE loans SET penalized = 1 WHERE id = ?').run(loan.id);
      recalcKarma(loan.borrower_id);
    }
  })();
  res.json({ loan_id: loan.id, status: 'returned', late: Boolean(late), message: `«${loan.title}» повернуто. Не забудьте оцінити одне одного!` });
}));

// ---------- Чат ----------

app.get('/api/loans/:id/messages', requireAuth, h((req, res) => {
  const loan = getLoanFor(req, intId(req.params.id));
  const messages = db
    .prepare(
      `SELECT m.id, m.sender_id, m.text, m.created_at, u.name AS sender_name
       FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.loan_id = ? ORDER BY m.id`
    )
    .all(loan.id);
  if (loan.borrower_id === req.user.id || loan.owner_id === req.user.id) {
    db.prepare('UPDATE messages SET is_read = 1 WHERE loan_id = ? AND sender_id != ? AND is_read = 0').run(loan.id, req.user.id);
  }
  res.json({ messages });
}));

app.post('/api/loans/:id/messages', requireAuth, h((req, res) => {
  const loan = getLoanFor(req, intId(req.params.id));
  if (loan.borrower_id !== req.user.id && loan.owner_id !== req.user.id) fail(403, 'Писати можуть лише учасники позики');
  const body = text(req.body.text, { field: 'Повідомлення', min: 1, max: 500 });
  const id = db
    .prepare('INSERT INTO messages (loan_id, sender_id, text, created_at) VALUES (?, ?, ?, ?)')
    .run(loan.id, req.user.id, body, nowIso()).lastInsertRowid;
  res.status(201).json({ id });
}));

// ---------- Відгуки та карма ----------

app.post('/api/loans/:id/review', requireAuth, h((req, res) => {
  const loan = getLoanFor(req, intId(req.params.id));
  const me = req.user.id;
  if (loan.borrower_id !== me && loan.owner_id !== me) fail(403, 'Оцінювати можуть лише учасники позики');
  if (loan.status !== 'returned') fail(409, 'Оцінку можна поставити після повернення речі');
  const rating = Number(req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) fail(400, 'Оцінка має бути від 1 до 5');
  const comment = text(req.body.comment, { field: 'Коментар', max: 300 });
  const target = loan.borrower_id === me ? loan.owner_id : loan.borrower_id;
  if (db.prepare('SELECT 1 FROM reviews WHERE loan_id = ? AND author_id = ?').get(loan.id, me)) fail(409, 'Ти вже оцінив цю позику');
  let karma;
  db.transaction(() => {
    db.prepare('INSERT INTO reviews (loan_id, author_id, target_id, rating, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(loan.id, me, target, rating, comment, nowIso());
    karma = recalcKarma(target);
  })();
  res.status(201).json({ ok: true, target_karma: karma });
}));

// ---------- Профіль ----------

function reviewsAbout(userId) {
  return db
    .prepare(
      `SELECT r.rating, r.comment, r.created_at, u.name AS author_name, u.class AS author_class, i.title AS item_title
       FROM reviews r JOIN users u ON u.id = r.author_id JOIN loans l ON l.id = r.loan_id JOIN items i ON i.id = l.item_id
       WHERE r.target_id = ? ORDER BY r.created_at DESC LIMIT 50`
    )
    .all(userId);
}

app.get('/api/profile', requireAuth, (req, res) => {
  const me = req.user.id;
  const items = db
    .prepare(
      `SELECT i.*, (SELECT COUNT(*) FROM loans l WHERE l.item_id = i.id AND l.status = 'returned') AS times_lent
       FROM items i WHERE i.owner_id = ? AND i.is_deleted = 0 ORDER BY i.created_at DESC`
    )
    .all(me);
  const history = db
    .prepare(`${LOAN_SELECT} WHERE l.borrower_id = @me OR i.owner_id = @me ORDER BY l.created_at DESC LIMIT 50`)
    .all({ me });
  const stats = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM loans l JOIN items i ON i.id = l.item_id WHERE i.owner_id = @me AND l.status IN ('given','returned')) AS lent,
         (SELECT COUNT(*) FROM loans WHERE borrower_id = @me AND status IN ('given','returned')) AS borrowed,
         (SELECT COUNT(*) FROM loans WHERE borrower_id = @me AND penalized = 1) AS overdue`
    )
    .get({ me });
  res.json({ user: publicUser(req.user), items, history, reviews: reviewsAbout(me), stats });
});

app.get('/api/users/:id', requireAuth, h((req, res) => {
  const u = db.prepare('SELECT id, name, class, role, karma, is_blocked FROM users WHERE id = ?').get(intId(req.params.id));
  if (!u) fail(404, 'Користувача не знайдено');
  const items = db
    .prepare('SELECT id, title, category, photo, location, max_days, is_available FROM items WHERE owner_id = ? AND is_deleted = 0')
    .all(u.id);
  res.json({ user: u, items: u.is_blocked ? [] : items, reviews: reviewsAbout(u.id) });
}));

// ---------- Класний керівник ----------

app.get('/api/teacher/class', requireRole('teacher', 'admin'), h((req, res) => {
  let cls = req.user.class;
  if (req.user.role === 'admin') cls = CLASS_RE.test(req.query.class || '') ? req.query.class : '9-А';
  const students = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.karma, u.is_blocked,
         (SELECT COUNT(*) FROM items i WHERE i.owner_id = u.id AND i.is_deleted = 0) AS items,
         (SELECT COUNT(*) FROM loans l WHERE l.borrower_id = u.id AND l.status = 'given') AS active,
         (SELECT COUNT(*) FROM loans l WHERE l.borrower_id = u.id AND l.status = 'given' AND l.due_date < @now) AS overdue
       FROM users u WHERE u.class = @cls AND u.role = 'student' ORDER BY u.name`
    )
    .all({ cls, now: nowIso() });
  const loans = db
    .prepare(`${LOAN_SELECT} WHERE l.status = 'given' AND (b.class = @cls OR o.class = @cls) ORDER BY l.due_date`)
    .all({ cls });
  const classes = db.prepare("SELECT DISTINCT class FROM users WHERE role = 'student' ORDER BY class").all().map((r) => r.class);
  res.json({ class: cls, classes, students, loans });
}));

// ---------- Адміністратор ----------

app.get('/api/admin/users', requireRole('admin'), (req, res) => {
  const users = db
    .prepare(
      `SELECT u.id, u.name, u.class, u.email, u.role, u.karma, u.is_blocked, u.created_at,
         (SELECT COUNT(*) FROM items i WHERE i.owner_id = u.id AND i.is_deleted = 0) AS items,
         (SELECT COUNT(*) FROM loans l WHERE l.borrower_id = u.id AND l.penalized = 1) AS overdue
       FROM users u ORDER BY u.role, u.class, u.name`
    )
    .all();
  const stats = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM users) AS users,
              (SELECT COUNT(*) FROM items WHERE is_deleted = 0) AS items,
              (SELECT COUNT(*) FROM loans WHERE status = 'given') AS active,
              (SELECT COUNT(*) FROM loans WHERE status = 'returned') AS returned`
    )
    .get();
  res.json({ users, stats });
});

app.post('/api/admin/users/:id/block', requireRole('admin'), h((req, res) => {
  const id = intId(req.params.id);
  const blocked = req.body.blocked ? 1 : 0;
  const u = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
  if (!u) fail(404, 'Користувача не знайдено');
  if (u.role === 'admin') fail(400, 'Адміністратора заблокувати не можна');
  db.prepare('UPDATE users SET is_blocked = ? WHERE id = ?').run(blocked, id);
  res.json({ ok: true, is_blocked: blocked });
}));

app.get('/api/admin/items', requireRole('admin'), (req, res) => {
  const items = db
    .prepare(`${ITEM_SELECT}, u.email AS owner_email FROM items i JOIN users u ON u.id = i.owner_id
              WHERE i.is_deleted = 0 ORDER BY i.created_at DESC`)
    .all();
  res.json({ items });
});

// ---------- Обробка помилок ----------

app.use('/api', (req, res) => res.status(404).json({ error: 'Маршрут не знайдено' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Запит завеликий' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некоректний JSON' });
  console.error(err);
  res.status(500).json({ error: 'Внутрішня помилка сервера' });
});

app.listen(PORT, () => {
  console.log(`📦 ПозичКа працює: http://localhost:${PORT}`);
});
