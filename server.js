// ============================================================
//  FITNESS & GYM CRM — точка входа
//  Express + Helmet + Rate limit + SQLite + Telegram Bot
// ============================================================

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const path       = require('path');
const rateLimit  = require('express-rate-limit');

const { initDb }                  = require('./src/db');
const { authMiddleware }          = require('./src/auth');
const { registerRoutes }          = require('./src/routes');
const { startBot, stopBot }       = require('./src/bot');

// ------------------------------------------------------------
// Валидация обязательных переменных окружения
// ------------------------------------------------------------
function validateEnv() {
  const required = ['BOT_TOKEN', 'ADMIN_TELEGRAM_IDS'];
  const missing = required.filter(k => !process.env[k]);

  if (missing.length && process.env.DEV_MODE !== 'true') {
    console.error(`[ENV]   Отсутствуют переменные: ${missing.join(', ')}`);
    console.error(`[ENV]   Заполни .env или включи DEV_MODE=true для локальной разработки`);
    process.exit(1);
  }
}

// ------------------------------------------------------------
// Инициализация Express
// ------------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// ---- Безопасность: HTTP-заголовки ---------------------------
app.use(helmet({
  contentSecurityPolicy: false,           // отключаем для inline-скриптов Mini App
  crossOriginEmbedderPolicy: false,       // отключаем для CDN
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// ---- CORS ---------------------------------------------------
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Telegram-Init-Data'],
}));

// ---- Тело запроса с ограничением размера ---------------------
app.use(express.json({ limit: '256kb' }));

// ---- Глобальный rate-limit (защита от спама) ----------------
app.use(rateLimit({
  windowMs: 60 * 1000,       // 1 минута
  max: 300,                  // 300 запросов с одного IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'TOO_MANY_REQUESTS' },
}));

// ---- Жёсткий rate-limit для чувствительных действий ---------
const sensitiveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'TOO_MANY_REQUESTS' },
});

// ---- Статика: фронтенд из public/ ---------------------------
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  etag: true,
}));

// ------------------------------------------------------------
// Health-check (для мониторинга)
// ------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
  });
});

// ------------------------------------------------------------
// Авторизация через Telegram initData
// ------------------------------------------------------------
app.post('/api/auth/telegram', sensitiveLimiter, authMiddleware, (req, res) => {
  res.json({ ok: true, admin: req.admin });
});

// ------------------------------------------------------------
// Все защищённые REST-роуты
// ------------------------------------------------------------
registerRoutes(app, authMiddleware);

// ------------------------------------------------------------
// SPA fallback — любой не-API путь отдаёт index.html
// ------------------------------------------------------------
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ------------------------------------------------------------
// Глобальный обработчик ошибок
// Клиент никогда не увидит внутренние подробности
// ------------------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message);
  const status = err.status || 500;
  const message = status < 500 ? err.message : 'INTERNAL_ERROR';
  res.status(status).json({ ok: false, error: message });
});

// ------------------------------------------------------------
// Запуск приложения
// ------------------------------------------------------------
(async () => {
  try {
    validateEnv();
    initDb();
    startBot();

    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log('──────────────────────────────────────────────');
      console.log(`[API]   http://localhost:${PORT}`);
      console.log(`[ENV]   ${process.env.NODE_ENV || 'development'}`);
      console.log(`[MODE]  ${process.env.DEV_MODE === 'true' ? 'DEV (без Telegram)' : 'PROD (Telegram)'}`);
      console.log('──────────────────────────────────────────────');
    });

    // ---- Graceful shutdown ---------------------------------
    const shutdown = (signal) => {
      console.log(`\n[SYS]   ${signal} — останавливаюсь…`);
      server.close(() => {
        stopBot();
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 5000);
    };

    process.once('SIGINT',  () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));

  } catch (e) {
    console.error('[STARTUP ERROR]', e);
    process.exit(1);
  }
})();