// ============================================================
//  FITNESS & GYM CRM — Авторизация
//  HMAC-SHA256 валидация Telegram initData
//  Проверка ADMIN_TELEGRAM_IDS
// ============================================================

const crypto = require('crypto');
const { getDb } = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const BOT_SECRET = crypto
  .createHmac('sha256', 'WebAppData')
  .update(BOT_TOKEN)
  .digest();

const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ------------------------------------------------------------
// Проверка подписи initData от Telegram
// Возвращает объект пользователя или null
// ------------------------------------------------------------
function validateInitData(initData) {
  if (!initData || typeof initData !== 'string') return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;

  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const computed = crypto
    .createHmac('sha256', BOT_SECRET)
    .update(dataCheckString)
    .digest('hex');

  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  // Данные старше 24 часов не принимаем
  const authDate = Number(params.get('auth_date') || 0);
  if (authDate && Date.now() / 1000 - authDate > 86400) return null;

  try {
    const raw = params.get('user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// Express-middleware
// Проверяет initData, находит или создаёт админа
// ------------------------------------------------------------
function authMiddleware(req, res, next) {
  try {
    const initData =
      req.headers['x-telegram-init-data'] ||
      req.body?.initData ||
      req.query?.initData;

    const tgUser = validateInitData(initData);

    // DEV-режим: пропускаем без initData (только для локального теста)
    if (!tgUser && process.env.DEV_MODE === 'true') {
      req.admin = { id: 1, telegramId: '0', username: 'dev', firstName: 'Dev' };
      return next();
    }

    if (!tgUser) {
      return res.status(401).json({ ok: false, error: 'INVALID_INIT_DATA' });
    }

    const tgId = String(tgUser.id);

    // Проверка по списку разрешённых админов
    if (ADMIN_IDS.length > 0 && !ADMIN_IDS.includes(tgId)) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }

    const db = getDb();
    let admin = db.prepare('SELECT * FROM admins WHERE telegram_id = ?').get(tgId);

    if (!admin) {
      const info = db.prepare(
        'INSERT INTO admins (telegram_id, username, first_name) VALUES (?, ?, ?)'
      ).run(tgId, tgUser.username || null, tgUser.first_name || null);
      admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(info.lastInsertRowid);
    }

    req.admin = {
      id: admin.id,
      telegramId: admin.telegram_id,
      username: admin.username,
      firstName: admin.first_name,
    };
    next();
  } catch (e) {
    next(e);
  }
}

module.exports = { authMiddleware, validateInitData };