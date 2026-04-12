// Catch ALL errors as early as possible — before any require() calls
process.on('uncaughtException', (err) => console.error('[fatal] uncaughtException:', err.message, err.stack));
process.on('unhandledRejection', (err) => console.error('[fatal] unhandledRejection:', err));
// Redirect stderr to stdout so Railway log viewer shows everything
const origStderr = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...args) => {
  process.stdout.write(chunk, ...args);
  return origStderr(chunk, ...args);
};

const { Telegraf, Markup } = require('telegraf');
const { TELEGRAM_BOT_TOKEN } = require('../../shared/config');
const { getUser } = require('../../shared/helpers');

const { buildSettingsText, buildSettingsKeyboard } = require('./handlers/settings');
const { getTasks } = require('../../application/tasks');

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// ─── Команды ─────────────────────────────────────────────

bot.start(async (ctx) => {
  const userId   = getUser(ctx);
  const firstName = ctx.from.first_name ?? 'друг';
  const isNew    = getTasks(userId, {}).length === 0;

  if (isNew) {
    await ctx.reply(
      `👋 Привет, ${firstName}!\n\n` +
      `Я — *Ordo*, твой личный ассистент задач.\n\n` +
      `*Как это работает:*\n` +
      `📥 Напиши или скажи задачу — запишу без лишних полей\n` +
      `📅 Каждое утро пришлю план на день\n` +
      `🔍 Каждый вечер разберём что зависло\n\n` +
      `*Попробуй прямо сейчас* — напиши любую задачу или отправь голосовое:\n` +
      `_"Купить молоко", "Позвонить маме завтра", "Записаться к врачу в четверг"_`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⚙️ Настроить время напоминаний', 'onb_settings')],
        ]),
      }
    );
  } else {
    await ctx.reply(
      `С возвращением, ${firstName}! 👋\n\n` +
      `Напиши или скажи задачу, или выбери команду:\n` +
      `/plan — план на сегодня\n` +
      `/tasks — список задач\n` +
      `/review — разбор зависших`
    );
  }
});

// Онбординг — открыть настройки
bot.action('onb_settings', async (ctx) => {
  const userId = getUser(ctx);
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await ctx.reply(buildSettingsText(userId), { parse_mode: 'Markdown', ...buildSettingsKeyboard(userId) });
});

bot.help((ctx) => {
  ctx.reply(
    'Как пользоваться:\n\n' +
    '1. Отправь голосовое или текстовое сообщение с задачей\n' +
    '2. Задача сохранится сразу — можно изменить или отменить\n\n' +
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
  const { handleText } = require('./handlers/intent'); // lazy — ok
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
require('./handlers/seed').register(bot);
require('./handlers/intent').register(bot);

// ─── Запуск ───────────────────────────────────────────────

const scheduler = require('./scheduler');
let schedulerTask;

// bot.launch() in long-polling mode never resolves — start scheduler right away
bot.launch().catch(err => console.error('[fatal] bot.launch() error:', err.message));
schedulerTask = scheduler.start(bot);
console.log('Бот запущен!');
bot.telegram.setMyCommands([
  { command: 'add',      description: 'Добавить задачу' },
  { command: 'tasks',    description: 'Список задач' },
  { command: 'goals',    description: 'Цели' },
  { command: 'plan',     description: 'План на день' },
  { command: 'review',   description: 'Разбор задач' },
  { command: 'settings',  description: 'Настройки и интеграции' },
  { command: 'help',     description: 'Помощь' },
]).catch(() => {});

process.once('SIGINT',  () => { scheduler.stop(schedulerTask); bot.stop('SIGINT'); });
process.once('SIGTERM', () => { scheduler.stop(schedulerTask); bot.stop('SIGTERM'); });
