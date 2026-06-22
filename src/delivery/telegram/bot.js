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
const { TELEGRAM_BOT_TOKEN, CURRENT_VERSION } = require('../../shared/config');
const { getUser } = require('../../shared/helpers');

const { buildSettingsText, buildSettingsKeyboard } = require('./handlers/settings');
const { startOnboarding } = require('./handlers/onboarding');
const { getTasks } = require('../../application/tasks');
const { getSettings, updateSettings } = require('../../application/settings');
const CHANGELOG = require('../../shared/changelog');
const db = require('../../infrastructure/db/connection');

const TYPE_ICON = { new: '✨', improved: '🔧', fixed: '🐛' };

// Форматирует одну версию для /whatsnew
function formatVersion(entry) {
  const grouped = {};
  for (const c of entry.changes) {
    (grouped[c.type] = grouped[c.type] ?? []).push(c.text);
  }
  const typeLabel = { new: 'Новое', improved: 'Улучшено', fixed: 'Исправлено' };
  const parts = [];
  for (const [type, items] of Object.entries(grouped)) {
    parts.push(`${TYPE_ICON[type] ?? '•'} *${typeLabel[type] ?? type}:*`);
    items.forEach(t => parts.push(`• ${t}`));
  }
  return parts.join('\n');
}

// Возвращает записи changelog новее чем lastSeen (макс 3 версии).
// changelog отсортирован новее-первым, поэтому берём с начала до индекса lastSeen.
function getNewEntries(lastSeen) {
  if (!lastSeen) return CHANGELOG.slice(0, 3);
  const idx = CHANGELOG.findIndex(e => e.version === lastSeen);
  if (idx <= 0) return [];
  return CHANGELOG.slice(0, Math.min(idx, 3));
}

// Формирует компактный список изменений для /start (только bullet-points, без группировки)
function formatChangesBrief(entries) {
  const seen = new Set();
  const lines = [];
  for (const e of entries) {
    for (const c of e.changes) {
      if (!seen.has(c.text)) { seen.add(c.text); lines.push(`• ${c.text}`); }
    }
  }
  return lines.join('\n');
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// ─── Команды ─────────────────────────────────────────────

bot.start(async (ctx) => {
  const userId    = getUser(ctx);
  const firstName = ctx.from.first_name ?? 'друг';
  const isNew     = getTasks(userId, {}).length === 0;

  if (isNew) {
    updateSettings(userId, { last_seen_version: CURRENT_VERSION });
    await startOnboarding(ctx);
    return;
  }

  const settings    = getSettings(userId);
  const newEntries  = getNewEntries(settings.last_seen_version);
  updateSettings(userId, { last_seen_version: CURRENT_VERSION });

  const todayTasks  = getTasks(userId, { plannedToday: true });
  const countLine   = todayTasks.length > 0 ? ` У тебя *${todayTasks.length}* задач${todayTasks.length === 1 ? 'а' : 'и'} на сегодня.` : '';

  let text = `С возвращением, ${firstName}! 👋${countLine}`;

  if (newEntries.length > 0) {
    const brief = formatChangesBrief(newEntries);
    text += `\n\n🎉 *Пока тебя не было, добавили:*\n${brief}`;
  }

  await ctx.reply(text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('📋 Открыть план', `mplan_${new Date().toISOString().slice(0, 10)}`)]])
  });
});

bot.command('whatsnew', (ctx) => {
  const latest = CHANGELOG[0];
  if (!latest) return ctx.reply('Список изменений пока пуст.');
  const text = `🎉 *Что нового в Ordo v${latest.version}*\n\n${formatVersion(latest)}`;
  ctx.reply(text, { parse_mode: 'Markdown' });
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
require('./handlers/media').register(bot);
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

// Рассылает changelog всем пользователям у кого last_seen_version устарела.
// Запускается один раз после старта — только при bump версии в package.json.
async function notifyChangelog() {
  const latest = CHANGELOG[0];
  if (!latest) return;

  // Пользователи с устаревшей или отсутствующей версией у которых есть задачи
  const users = db.prepare(`
    SELECT u.id, COALESCE(s.last_seen_version, '') AS last_seen_version
    FROM users u
    LEFT JOIN user_settings s ON s.user_id = u.id
    WHERE (s.last_seen_version IS NULL OR s.last_seen_version != ?)
      AND EXISTS (SELECT 1 FROM tasks t WHERE t.user_id = u.id)
  `).all(CURRENT_VERSION);

  if (!users.length) return;
  console.log(`[changelog] notifying ${users.length} users about v${CURRENT_VERSION}`);

  for (const user of users) {
    try {
      const newEntries = getNewEntries(user.last_seen_version || null);
      updateSettings(user.id, { last_seen_version: CURRENT_VERSION });

      if (!newEntries.length) continue;

      const text = `🎉 *Что нового в Ordo v${latest.version}*\n\n${formatVersion(latest)}`;
      await bot.telegram.sendMessage(user.id, text, { parse_mode: 'Markdown' });
    } catch (e) {
      // Пользователь заблокировал бота или другая сетевая ошибка — не критично
      console.error(`[changelog] user ${user.id}:`, e.message);
    }
  }
}

launchWithRetry().then(() => notifyChangelog());
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

module.exports = bot;
