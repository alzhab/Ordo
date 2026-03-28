const { Telegraf, Markup } = require('telegraf');
const { TELEGRAM_BOT_TOKEN } = require('./config');
const { getUser } = require('./helpers');

// Однократное восстановление данных из переменной окружения
if (process.env.RESTORE_DATA) {
  try {
    const db = require('./db');
    const code = Buffer.from(process.env.RESTORE_DATA, 'base64').toString('utf8');
    eval(code);
    console.log('✅ Данные восстановлены из RESTORE_DATA');
  } catch (e) {
    console.error('❌ Ошибка восстановления:', e.message);
  }
}
const { isConfigured: notionConfigured } = require('./integrations/notion');
const { buildSettingsText, buildSettingsKeyboard } = require('./handlers/settings');

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// ─── Команды ─────────────────────────────────────────────

bot.start((ctx) => {
  getUser(ctx);
  ctx.reply(
    'Привет! 👋 Я помогу создавать задачи.\n\n' +
    'Отправь голосовое сообщение или напиши задачу текстом.\n\n' +
    'Пример: «Купить провод для ремонта, категория дом, срок эти выходные»\n\n' +
    '/tasks — список задач\n' +
    '/today — задачи на сегодня'
  );
});

bot.help((ctx) => {
  ctx.reply(
    'Как пользоваться:\n\n' +
    '1. Отправь голосовое или текстовое сообщение с задачей\n' +
    '2. Я покажу превью — проверь и подтверди\n' +
    '3. Задача сохранится локально' +
    (notionConfigured() ? ' и синхронизируется с Notion' : '') + '\n\n' +
    '/tasks — список активных задач\n' +
    '/today — задачи на сегодня\n' +
    '/add — добавить задачу'
  );
});

bot.command('settings', (ctx) => {
  getUser(ctx);
  ctx.reply(buildSettingsText(), { parse_mode: 'Markdown', ...buildSettingsKeyboard() });
});

// /add — явная команда добавить задачу
bot.command('add', (ctx) => {
  const text = ctx.message.text.replace('/add', '').trim();
  if (!text) return ctx.reply('Напиши задачу после команды: /add Купить молоко');
  const { handleText } = require('./handlers/intent');
  handleText(ctx, text);
});

// ─── Глобальный обработчик ошибок ────────────────────────

bot.catch((err, ctx) => {
  console.error(`[bot.catch] update=${ctx?.update?.update_id}`, err);
  ctx?.reply('⚠️ Что-то пошло не так. Попробуй ещё раз.').catch(() => {});
});

// ─── Регистрация обработчиков ─────────────────────────────

require('./handlers/tasks').register(bot);
require('./handlers/plans').register(bot);
require('./handlers/subtasks').register(bot);
require('./handlers/settings').register(bot);
require('./handlers/intent').register(bot);

// ─── Запуск ───────────────────────────────────────────────

bot.launch().then(() => {
  console.log('Бот запущен!');
  bot.telegram.setMyCommands([
    { command: 'add',      description: 'Добавить задачу' },
    { command: 'tasks',    description: 'Список задач' },
    { command: 'today',    description: 'Задачи на сегодня' },
    { command: 'plans',    description: 'Планы' },
    { command: 'settings', description: 'Настройки и интеграции' },
    { command: 'help',     description: 'Помощь' },
  ]);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
