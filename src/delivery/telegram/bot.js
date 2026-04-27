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
const { startOnboarding } = require('./handlers/onboarding');
const { getTasks } = require('../../application/tasks');

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// ─── Команды ─────────────────────────────────────────────

bot.start(async (ctx) => {
  const userId    = getUser(ctx);
  const firstName = ctx.from.first_name ?? 'друг';
  const isNew     = getTasks(userId, {}).length === 0;

  if (isNew) {
    await startOnboarding(ctx);
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

// /onboarding — перезапустить онбординг (для тестирования и новых пользователей)
bot.command('onboarding', async (ctx) => {
  await startOnboarding(ctx);
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

require('./handlers/onboarding').register(bot);
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

// bot.launch() с retry — Railway иногда теряет сеть при старте
async function launchWithRetry(attempts = 5, delayMs = 5000) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await bot.launch();
      return;
    } catch (err) {
      console.error(`[fatal] bot.launch() error (attempt ${i}/${attempts}):`, err.message);
      if (i < attempts) {
        console.log(`[bot] retry in ${delayMs / 1000}s...`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  console.error('[fatal] bot.launch() failed after all retries, exiting');
  process.exit(1);
}
launchWithRetry();
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
