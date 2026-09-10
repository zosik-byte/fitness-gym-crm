// ============================================================
//  FITNESS & GYM CRM — База данных (SQLite)
//  Схема, миграция, seed демо-данных
// ============================================================

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || (process.env.AMVERA ? '/data/crm.db' : path.join(__dirname, '..', 'data', 'crm.db'));
let db = null;

// ------------------------------------------------------------
// Инициализация БД и создание таблиц
// ------------------------------------------------------------
function initDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id  TEXT UNIQUE NOT NULL,
      username     TEXT,
      first_name   TEXT,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS members (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name          TEXT NOT NULL,
      phone              TEXT,
      membership_ends_at TEXT,
      deposit            REAL NOT NULL DEFAULT 0,
      notes              TEXT,
      created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS payments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id   INTEGER NOT NULL,
      admin_id    INTEGER,
      days        INTEGER NOT NULL,
      amount      REAL NOT NULL,
      method      TEXT NOT NULL DEFAULT 'CASH',
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS deposits (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id      INTEGER NOT NULL,
      admin_id       INTEGER,
      amount         REAL NOT NULL,
      type           TEXT NOT NULL,
      note           TEXT,
      balance_after  REAL NOT NULL,
      created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS bar_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      category    TEXT NOT NULL DEFAULT 'DRINKS',
      price       REAL NOT NULL,
      cost        REAL NOT NULL DEFAULT 0,
      stock       INTEGER NOT NULL DEFAULT 0,
      min_stock   INTEGER NOT NULL DEFAULT 3,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS bar_sales (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id         INTEGER NOT NULL,
      member_id       INTEGER,
      admin_id        INTEGER,
      quantity        INTEGER NOT NULL,
      unit_price      REAL NOT NULL,
      total           REAL NOT NULL,
      payment_method  TEXT NOT NULL DEFAULT 'CASH',
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (item_id) REFERENCES bar_items(id)
    );

    CREATE INDEX IF NOT EXISTS idx_members_name    ON members(full_name);
    CREATE INDEX IF NOT EXISTS idx_payments_member ON payments(member_id);
    CREATE INDEX IF NOT EXISTS idx_payments_date   ON payments(created_at);
    CREATE INDEX IF NOT EXISTS idx_deposits_member ON deposits(member_id);
    CREATE INDEX IF NOT EXISTS idx_sales_item      ON bar_sales(item_id);
    CREATE INDEX IF NOT EXISTS idx_sales_date      ON bar_sales(created_at);
  `);

  seedIfEmpty();
  console.log('[DB]    ready at', DB_PATH);
}

// ------------------------------------------------------------
// Хелпер: доступ к БД
// ------------------------------------------------------------
function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

// ------------------------------------------------------------
// Наполнение демо-данными при первом запуске
// ------------------------------------------------------------
function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM members').get();
  if (count.c > 0) return;

  const now = Date.now();
  const day = n => new Date(now + n * 86400000).toISOString();

  const insertMember = db.prepare(
    'INSERT INTO members (full_name, phone, membership_ends_at, deposit) VALUES (?, ?, ?, ?)'
  );
  const members = [
    ['Александр Иванов',   '+7 999 111-22-33', day(45),  2500],
    ['Мария Петрова',      '+7 999 222-33-44', day(2),    800],
    ['Дмитрий Смирнов',    '+7 999 333-44-55', day(-5),     0],
    ['Екатерина Соколова', '+7 999 444-55-66', day(90),  5200],
    ['Иван Кузнецов',      '+7 999 555-66-77', day(1),    300],
    ['Ольга Морозова',     '+7 999 666-77-88', day(-12), 1200],
    ['Сергей Волков',      '+7 999 777-88-99', day(180),    0],
    ['Анна Лебедева',      '+7 999 888-99-00', day(15),  3400],
  ];
  members.forEach(m => insertMember.run(...m));

  const insertItem = db.prepare(
    'INSERT INTO bar_items (name, category, price, cost, stock, min_stock) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const items = [
    ['Вода BonAqua 0.5л',    'DRINKS', 100,  45, 24, 5],
    ['Изотоник Powerade',    'DRINKS', 180,  95,  2, 5],
    ['Протеиновый батончик', 'SPORT',  220, 120, 12, 3],
    ['Энергетик Red Bull',   'DRINKS', 250, 140,  8, 3],
    ['Шоколад Milka',        'SNACKS', 150,  80,  3, 5],
    ['Протеин Whey 30г',     'SPORT',  300, 180, 15, 3],
  ];
  items.forEach(i => insertItem.run(...i));

  // Демо-история за 60 дней — чтобы аналитика сразу показывала данные
  const insertPay  = db.prepare('INSERT INTO payments (member_id, days, amount, method, created_at) VALUES (?, ?, ?, ?, ?)');
  const insertSale = db.prepare('INSERT INTO bar_sales (item_id, quantity, unit_price, total, created_at) VALUES (?, ?, ?, ?, ?)');

  for (let i = 60; i >= 0; i--) {
    if (Math.random() < 0.35) {
      const mid    = 1 + Math.floor(Math.random() * members.length);
      const amount = [1500, 2000, 3000, 5000][Math.floor(Math.random() * 4)];
      const days   = [30, 30, 90, 180][Math.floor(Math.random() * 4)];
      insertPay.run(mid, days, amount, 'CASH', new Date(now - i * 86400000).toISOString());
    }
    const salesCount = Math.floor(Math.random() * 4);
    for (let j = 0; j < salesCount; j++) {
      const idx = Math.floor(Math.random() * items.length);
      const qty = 1 + Math.floor(Math.random() * 2);
      const price = items[idx][2];
      insertSale.run(idx + 1, qty, price, price * qty, new Date(now - i * 86400000).toISOString());
    }
  }

  console.log('[DB]    seeded demo data');
}

module.exports = { initDb, getDb };