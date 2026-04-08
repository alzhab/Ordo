const { Telegraf, Markup } = require('telegraf');
const { TELEGRAM_BOT_TOKEN } = require('./config');
const { getUser } = require('./helpers');

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
    '/tasks — список задач'
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
    '/add — добавить задачу'
  );
});

bot.command('settings', (ctx) => {
  const userId = getUser(ctx);
  ctx.reply(buildSettingsText(userId), { parse_mode: 'Markdown', ...buildSettingsKeyboard(userId) });
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
require('./handlers/goals').register(bot);
require('./handlers/subtasks').register(bot);
require('./handlers/settings').register(bot);
require('./handlers/assistant').register(bot);
require('./handlers/intent').register(bot);

// ─── Запуск ───────────────────────────────────────────────

const scheduler = require('./scheduler');
let schedulerTask;

process.on('uncaughtException', (err) => console.error('[fatal] uncaughtException:', err));
process.on('unhandledRejection', (err) => console.error('[fatal] unhandledRejection:', err));

bot.launch().then(() => {
  console.log('Бот запущен!');
  schedulerTask = scheduler.start(bot);
  bot.telegram.setMyCommands([
    { command: 'add',      description: 'Добавить задачу' },
    { command: 'tasks',    description: 'Список задач' },
    { command: 'goals',    description: 'Цели' },
    { command: 'plan',     description: 'План на день' },
    { command: 'review',   description: 'Вечерний разбор' },
    { command: 'progress',  description: 'Прогресс' },
    { command: 'reminders', description: 'Повторяющиеся напоминания' },
    { command: 'settings',  description: 'Настройки и интеграции' },
    { command: 'help',     description: 'Помощь' },
  ]);
});

process.once('SIGINT', () => { scheduler.stop(schedulerTask); bot.stop('SIGINT'); });
process.once('SIGTERM', () => { scheduler.stop(schedulerTask); bot.stop('SIGTERM'); });
