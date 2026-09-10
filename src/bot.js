// ============================================================
//  FITNESS & GYM CRM — Telegram Bot (Telegraf)
//  Команда /start, Menu Button, inline-кнопка Mini App
// ============================================================

const { Telegraf, Markup } = require('telegraf');

let botInstance = null;

// ------------------------------------------------------------
// Запуск бота
// ------------------------------------------------------------
function startBot() {
  const BOT_TOKEN  = process.env.BOT_TOKEN;
  const WEBAPP_URL = process.env.WEBAPP_URL;

  if (!BOT_TOKEN) {
    console.warn('[BOT]   BOT_TOKEN не задан — бот не запущен');
    return null;
  }

  const bot = new Telegraf(BOT_TOKEN);
  botInstance = bot;

  // ----------------------------------------------------------
  // /start — приветствие + inline-кнопка Mini App
  // ----------------------------------------------------------
  bot.start(async (ctx) => {
    const name = ctx.from?.first_name || 'друг';

    const keyboard = WEBAPP_URL
      ? Markup.inlineKeyboard([
          [Markup.button.webApp('🏋️ Открыть FITNESS & GYM', WEBAPP_URL)],
        ])
      : undefined;

    await ctx.reply(
      `Привет, ${name}! 👋\n\n` +
      `Это CRM-помощник фитнес-клуба *FITNESS & GYM*.\n\n` +
      `Здесь вы можете:\n` +
      `• 👥 Управлять клиентами и абонементами\n` +
      `• 💰 Работать с депозитами\n` +
      `• 🍷 Продавать товары из бара\n` +
      `• 📊 Смотреть аналитику выручки`,
      { parse_mode: 'Markdown', ...keyboard }
    );

    // Устанавливаем Menu Button для этого чата
    if (WEBAPP_URL) {
      try {
        await ctx.telegram.setChatMenuButton({
          chat_id: ctx.chat.id,
          menu_button: {
            type: 'web_app',
            text: 'FITNESS & GYM',
            web_app: { url: WEBAPP_URL },
          },
        });
      } catch (_) {}
    }
  });

  // ----------------------------------------------------------
  // /help — справка
  // ----------------------------------------------------------
  bot.command('help', (ctx) => {
    ctx.reply(
      `*FITNESS & GYM CRM*\n\n` +
      `Доступные команды:\n` +
      `/start — открыть главное меню\n` +
      `/help — эта справка\n\n` +
      `Весь функционал доступен внутри Mini App — жмите кнопку «🏋️ Открыть FITNESS & GYM».`,
      { parse_mode: 'Markdown' }
    );
  });

  // ----------------------------------------------------------
  // Обработка ошибок
  // ----------------------------------------------------------
  bot.catch((err, ctx) => {
    console.error('[BOT]   error:', err?.message || err);
  });

  // ----------------------------------------------------------
  // Запуск
  // ----------------------------------------------------------
  bot.launch({ dropPendingUpdates: true })
    .then(async () => {
      console.log('[BOT]   launched');

      // Устанавливаем глобальный Menu Button для всех чатов
      if (WEBAPP_URL) {
        try {
          await bot.telegram.setChatMenuButton({
            menu_button: {
              type: 'web_app',
              text: 'FITNESS & GYM',
              web_app: { url: WEBAPP_URL },
            },
          });
          console.log('[BOT]   menu button set');
        } catch (e) {
          console.warn('[BOT]   setChatMenuButton failed:', e.message);
        }
      }
    })
    .catch((e) => {
      console.error('[BOT]   launch failed:', e.message);
    });

  // Graceful shutdown
  process.once('SIGINT',  () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  return bot;
}

// ------------------------------------------------------------
// Остановка бота (для graceful shutdown из server.js)
// ------------------------------------------------------------
function stopBot() {
  if (botInstance) {
    try { botInstance.stop(); } catch (_) {}
  }
}

module.exports = { startBot, stopBot };