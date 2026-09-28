// База даних ПозичКи: схема, демо-дані та логіка карми.
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'pozychka.db');
const CATEGORIES = ['Зарядки', 'Канцелярія', 'Книги', 'Спорт', 'Інше'];
const DAY = 24 * 60 * 60 * 1000;

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// SQLite LIKE/lower() не розуміють кирилицю, тому реєструємо власну функцію.
db.function('ulower', { deterministic: true }, (s) => (s == null ? '' : String(s).toLocaleLowerCase('uk-UA')));

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  class         TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'teacher', 'admin')),
  karma         REAL    NOT NULL DEFAULT 5.0,
  is_blocked    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id     INTEGER NOT NULL REFERENCES users(id),
  title        TEXT    NOT NULL,
  category     TEXT    NOT NULL CHECK (category IN ('Зарядки', 'Канцелярія', 'Книги', 'Спорт', 'Інше')),
  description  TEXT    NOT NULL DEFAULT '',
  photo        TEXT,
  location     TEXT    NOT NULL,
  max_days     INTEGER NOT NULL DEFAULT 1 CHECK (max_days BETWEEN 1 AND 30),
  is_available INTEGER NOT NULL DEFAULT 1,
  is_deleted   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS loans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL REFERENCES items(id),
  borrower_id INTEGER NOT NULL REFERENCES users(id),
  status      TEXT    NOT NULL DEFAULT 'requested'
              CHECK (status IN ('requested', 'approved', 'rejected', 'given', 'returned')),
  created_at  TEXT    NOT NULL,
  due_date    TEXT,
  qr_code     TEXT UNIQUE,
  given_at    TEXT,
  returned_at TEXT,
  penalized   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reviews (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id    INTEGER NOT NULL REFERENCES loans(id),
  author_id  INTEGER NOT NULL REFERENCES users(id),
  target_id  INTEGER NOT NULL REFERENCES users(id),
  rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment    TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL,
  UNIQUE (loan_id, author_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id    INTEGER NOT NULL REFERENCES loans(id),
  sender_id  INTEGER NOT NULL REFERENCES users(id),
  text       TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  is_read    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_items_owner   ON items(owner_id);
CREATE INDEX IF NOT EXISTS idx_loans_item    ON loans(item_id);
CREATE INDEX IF NOT EXISTS idx_loans_borrow  ON loans(borrower_id);
CREATE INDEX IF NOT EXISTS idx_reviews_tgt   ON reviews(target_id);
CREATE INDEX IF NOT EXISTS idx_messages_loan ON messages(loan_id);
`);

const nowIso = () => new Date().toISOString();
const isoIn = (ms) => new Date(Date.now() + ms).toISOString();

// Короткий код для QR та ручного введення (без схожих символів 0/O, 1/I).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 8; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!db.prepare('SELECT 1 FROM loans WHERE qr_code = ?').get(code)) return code;
  }
}

// Карма = середня оцінка з відгуків (5.0, якщо відгуків ще немає) мінус 0.5 за кожне прострочення.
// Якщо карма учня опускається нижче 2 — акаунт блокується автоматично.
function recalcKarma(userId, { autoBlock = true } = {}) {
  const r = db.prepare('SELECT AVG(rating) AS avg, COUNT(*) AS n FROM reviews WHERE target_id = ?').get(userId);
  const p = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE borrower_id = ? AND penalized = 1').get(userId);
  const base = r.n ? r.avg : 5;
  const karma = Math.round(Math.min(5, Math.max(0, base - 0.5 * p.n)) * 10) / 10;
  db.prepare('UPDATE users SET karma = ? WHERE id = ?').run(karma, userId);
  if (autoBlock && karma < 2) {
    db.prepare("UPDATE users SET is_blocked = 1 WHERE id = ? AND role = 'student'").run(userId);
  }
  return karma;
}

// Знімає 0.5 карми за кожну позику, термін якої минув, а річ досі не повернуто.
function applyOverduePenalties() {
  const overdue = db
    .prepare("SELECT id, borrower_id FROM loans WHERE status = 'given' AND penalized = 0 AND due_date < ?")
    .all(nowIso());
  const mark = db.prepare('UPDATE loans SET penalized = 1 WHERE id = ?');
  for (const loan of overdue) {
    mark.run(loan.id);
    recalcKarma(loan.borrower_id);
  }
  return overdue.length;
}

function seed() {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return false;

  const hash = (p) => bcrypt.hashSync(p, 10);
  const studentPass = hash('123456');
  const insUser = db.prepare(
    'INSERT INTO users (name, class, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insItem = db.prepare(
    `INSERT INTO items (owner_id, title, category, description, location, max_days, is_available, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insLoan = db.prepare(
    `INSERT INTO loans (item_id, borrower_id, status, created_at, due_date, qr_code, given_at, returned_at, penalized)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insReview = db.prepare(
    'INSERT INTO reviews (loan_id, author_id, target_id, rating, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insMsg = db.prepare(
    'INSERT INTO messages (loan_id, sender_id, text, created_at, is_read) VALUES (?, ?, ?, ?, ?)'
  );
  const ago = (days) => isoIn(-days * DAY);

  db.transaction(() => {
    const t = nowIso();
    insUser.run('Адміністратор', '—', 'admin@school.ua', hash('admin123'), 'admin', t);
    insUser.run('Ірина Петрівна', '9-А', 'teacher@school.ua', hash('teacher123'), 'teacher', t);
    const olena = insUser.run('Олена Коваль', '9-А', 'olena@school.ua', studentPass, 'student', t).lastInsertRowid;
    const maksym = insUser.run('Максим Бондар', '9-Б', 'maksym@school.ua', studentPass, 'student', t).lastInsertRowid;
    const sofia = insUser.run('Софія Шевченко', '10-А', 'sofia@school.ua', studentPass, 'student', t).lastInsertRowid;
    const andrii = insUser.run('Андрій Мельник', '9-А', 'andrii@school.ua', studentPass, 'student', t).lastInsertRowid;
    const dmytro = insUser.run('Дмитро Ткаченко', '10-А', 'dmytro@school.ua', studentPass, 'student', t).lastInsertRowid;

    const item = (owner, title, cat, desc, loc, days, avail = 1) =>
      insItem.run(owner, title, cat, desc, loc, days, avail, ago(20)).lastInsertRowid;
    const typeC = item(maksym, 'Зарядка Type-C', 'Зарядки', 'Швидка зарядка 20 Вт, кабель 1 м.', 'каб. 24, 2 поверх', 1);
    item(sofia, 'Зарядка Lightning для iPhone', 'Зарядки', 'Оригінальний кабель, без блока живлення.', 'каб. 31, 3 поверх', 1);
    const powerbank = item(dmytro, 'Павербанк 10 000 мА·год', 'Зарядки', 'Заряджений, два USB-виходи.', 'каб. 35, 3 поверх', 1);
    const calc = item(sofia, 'Інженерний калькулятор Casio', 'Канцелярія', 'Casio fx-82. Можна на контрольну з алгебри.', 'каб. 31, 3 поверх', 3);
    const pens = item(olena, 'Набір кольорових ручок', 'Канцелярія', '12 кольорів, гелеві.', 'каб. 12, 1 поверх', 2);
    const uniform = item(andrii, 'Спортивна форма (розмір M)', 'Спорт', 'Футболка та шорти, чисті 🙂', 'спортзал', 2, 0);
    const ball = item(dmytro, "Футбольний м'яч", 'Спорт', "М'яч №5, накачаний.", 'спортзал', 1, 0);
    const book = item(olena, '«Тіні забутих предків» — М. Коцюбинський', 'Книги', 'Шкільна програма, 9 клас. Без позначок.', 'бібліотека, 1 поверх', 14);
    const murphy = item(maksym, 'English Grammar in Use (Murphy)', 'Книги', 'Синя книга, рівень Intermediate.', 'каб. 24, 2 поверх', 7, 0);
    const headphones = item(andrii, 'Навушники з мікрофоном', 'Інше', 'Дротові, роз’єм 3.5 мм.', 'каб. 18, 2 поверх', 1);

    const loan = (itemId, borrower, status, created, extra = {}) =>
      insLoan.run(
        itemId, borrower, status, created,
        extra.due ?? null, extra.qr ?? null, extra.given ?? null, extra.returned ?? null, extra.penalized ?? 0
      ).lastInsertRowid;

    // Завершені позики з відгуками — щоб карма відрізнялась.
    const l1 = loan(calc, olena, 'returned', ago(14), { given: ago(13), due: ago(10), returned: ago(11) });
    insReview.run(l1, sofia, olena, 5, 'Повернула вчасно, все акуратно!', ago(11));
    insReview.run(l1, olena, sofia, 5, 'Дуже виручила на контрольній, дякую!', ago(11));

    const l2 = loan(typeC, andrii, 'returned', ago(9), { given: ago(9), due: ago(8), returned: ago(8) });
    insReview.run(l2, maksym, andrii, 4, 'Все ок, але довелося нагадувати.', ago(8));
    insReview.run(l2, andrii, maksym, 5, 'Швидко відгукнувся, супер.', ago(8));

    const l3 = loan(book, dmytro, 'returned', ago(30), { given: ago(29), due: ago(15), returned: ago(12), penalized: 1 });
    insReview.run(l3, olena, dmytro, 3, 'Повернув із запізненням на три дні.', ago(12));
    insReview.run(l3, dmytro, olena, 5, 'Класна книга, дякую!', ago(12));

    const l4 = loan(powerbank, sofia, 'returned', ago(6), { given: ago(6), due: ago(5), returned: ago(5) });
    insReview.run(l4, dmytro, sofia, 5, 'Повернула повністю зарядженим 👍', ago(5));
    insReview.run(l4, sofia, dmytro, 4, 'Дякую, дуже допоміг.', ago(5));

    // Активні позики.
    const l5 = loan(uniform, olena, 'given', ago(1), { given: ago(1), due: isoIn(1 * DAY), qr: generateCode() });
    insMsg.run(l5, olena, 'Привіт! Можна взяти форму на фізкультуру?', ago(1.1), 1);
    insMsg.run(l5, andrii, 'Так, підходь до спортзалу на перерві.', ago(1.05), 1);
    insMsg.run(l5, andrii, 'Не забудь повернути завтра після уроків 🙂', ago(0.2), 0);

    // Прострочена позика: штраф −0.5 нарахується автоматично під час запуску сервера.
    const l6 = loan(ball, maksym, 'given', ago(4), { given: ago(4), due: ago(2), qr: generateCode() });
    insMsg.run(l6, dmytro, "Максиме, де м'яч? Термін минув два дні тому.", ago(1), 0);

    const l7 = loan(murphy, andrii, 'approved', ago(0.3), { qr: generateCode() });
    insMsg.run(l7, andrii, 'Дякую! Зайду на великій перерві.', ago(0.25), 1);

    // Запити, що очікують рішення, та відхилений запит.
    loan(powerbank, olena, 'requested', ago(0.1));
    const l9 = loan(pens, sofia, 'requested', ago(0.05));
    insMsg.run(l9, sofia, 'Олено, позич, будь ласка, ручки на урок малювання 🙏', ago(0.05), 0);
    loan(headphones, maksym, 'rejected', ago(3));

    for (const u of [olena, maksym, sofia, andrii, dmytro]) recalcKarma(u, { autoBlock: false });
  })();
  return true;
}

module.exports = { db, CATEGORIES, DAY, nowIso, isoIn, generateCode, recalcKarma, applyOverduePenalties, seed };
