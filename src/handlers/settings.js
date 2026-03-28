const { Markup } = require('telegraf');
const { getUser, safeEdit, safeDelete } = require('../helpers');
const { pendingTasks } = require('../state');
const { getCategories, createCategory, getCategoryTaskCount, deleteCategory } = require('../categoryService');
const { isConfigured: notionConfigured, isPlansConfigured } = require('../integrations/notion');
const { getSyncErrors, clearSyncErrors } = require('../syncErrorService');
const { getNotionEnabled, updateSettings } = require('../assistantService');

function buildSettingsText(userId) {
  const notionTasks = notionConfigured()
    ? '✅ Notion задачи подключён'
    : '❌ Notion задачи не настроен';
  const notionPlans = isPlansConfigured()
    ? '✅ Notion планы подключён'
    : '❌ Notion планы не настроен';
  const syncStatus = userId && notionConfigured()
    ? (getNotionEnabled(userId) ? '\n🔔 Синхронизация: включена' : '\n🔕 Синхронизация: отключена')
    : '';
  return `⚙️ *Настройки*\n\n*Интеграции:*\n${notionTasks}\n${notionPlans}${syncStatus}`;
}

function buildSettingsKeyboard(userId) {
  const rows = [];
  if (notionConfigured()) {
    const syncEnabled = userId ? getNotionEnabled(userId) : true;
    rows.push([Markup.button.callback(
      syncEnabled ? '🔕 Отключить синхронизацию' : '🔔 Включить синхронизацию',
      'settings_notion_toggle'
    )]);
    if (syncEnabled) {
      rows.push([Markup.button.callback('🔄 Синхронизировать задачи → Notion', 'notion_sync_all')]);
    }
    rows.push([Markup.button.callback('⚠️ Ошибки синхронизации', 'settings_sync_errors')]);
  }
  rows.push([Markup.button.callback('📁 Категории', 'settings_categories')]);
  return Markup.inlineKeyboard(rows);
}

function register(bot) {
  // Ошибки синхронизации
  bot.action('settings_sync_errors', async (ctx) => {
    const userId = getUser(ctx);
    const errors = getSyncErrors(userId);
    await ctx.answerCbQuery();
    if (errors.length === 0) {
      return safeEdit(ctx, '✅ Ошибок синхронизации нет.', {
        ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', 'settings_back')]]),
      });
    }
    const lines = errors.map(e => `• \`${e.created_at.slice(5, 16)}\` ${e.message}`).join('\n');
    await safeEdit(ctx, `⚠️ *Последние ошибки sync:*\n\n${lines}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🗑 Очистить', 'settings_errors_clear')],
        [Markup.button.callback('◀️ Назад', 'settings_back')],
      ]),
    });
  });

  bot.action('settings_errors_clear', async (ctx) => {
    const userId = getUser(ctx);
    clearSyncErrors(userId);
    await ctx.answerCbQuery('🗑 Очищено');
    await safeEdit(ctx, '✅ Ошибки синхронизации очищены.', {
      ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', 'settings_back')]]),
    });
  });

  bot.action('settings_notion_toggle', async (ctx) => {
    const userId = getUser(ctx);
    const enabled = getNotionEnabled(userId);
    updateSettings(userId, { notion_enabled: enabled ? 0 : 1 });
    await ctx.answerCbQuery(enabled ? '🔕 Синхронизация отключена' : '🔔 Синхронизация включена');
    await safeEdit(ctx, buildSettingsText(userId), { parse_mode: 'Markdown', ...buildSettingsKeyboard(userId) });
  });

  bot.action('settings_back', async (ctx) => {
    const userId = getUser(ctx);
    await ctx.answerCbQuery();
    await safeEdit(ctx, buildSettingsText(userId), { parse_mode: 'Markdown', ...buildSettingsKeyboard(userId) });
  });

  // Вход в раздел категорий
  bot.action('settings_categories', async (ctx) => {
    const userId = getUser(ctx);
    await ctx.answerCbQuery();
    await renderCategoryList(ctx, userId, true);
  });

  // Добавить категорию
  bot.action('scat_add', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId) ?? {};
    state.creatingCategory = true;
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await safeEdit(ctx, '📁 *Новая категория*\n\nОтправь название:', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', 'settings_categories')]]),
    });
  });

  // Просмотр категории (кнопка удалить)
  bot.action(/^scat_view_(\d+)$/, async (ctx) => {
    const catId  = Number(ctx.match[1]);
    const userId = getUser(ctx);
    const cats   = getCategories(userId);
    const cat    = cats.find(c => c.id === catId);
    if (!cat) return ctx.answerCbQuery('Категория не найдена.');
    const count  = getCategoryTaskCount(catId);
    await ctx.answerCbQuery();
    const canDelete = count === 0;
    const rows = [];
    if (canDelete) {
      rows.push([Markup.button.callback('🗑 Удалить', `scat_del_${catId}`)]);
    } else {
      rows.push([Markup.button.callback(`⚠️ Есть задачи (${count}) — нельзя удалить`, 'scat_noop')]);
    }
    rows.push([Markup.button.callback('◀️ Назад', 'settings_categories')]);
    await safeEdit(ctx, `📁 *${cat.name}*\n\nЗадач: ${count}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(rows),
    });
  });

  bot.action('scat_noop', (ctx) => ctx.answerCbQuery());

  // Удаление категории
  bot.action(/^scat_del_(\d+)$/, async (ctx) => {
    const catId  = Number(ctx.match[1]);
    const userId = getUser(ctx);
    const count  = getCategoryTaskCount(catId);
    if (count > 0) return ctx.answerCbQuery('Есть активные задачи — удаление невозможно.');
    deleteCategory(catId);
    await ctx.answerCbQuery('🗑 Удалено');
    await renderCategoryList(ctx, userId, true);
  });
}

async function renderCategoryList(ctx, userId, edit = false) {
  const cats = getCategories(userId);
  const rows = cats.map(c => [Markup.button.callback(`📁 ${c.name}`, `scat_view_${c.id}`)]);
  rows.push([Markup.button.callback('➕ Добавить категорию', 'scat_add')]);
  const text = `📁 *Категории* (${cats.length}):`;
  const opts = { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) };
  return edit ? ctx.editMessageText(text, opts) : ctx.reply(text, opts);
}

module.exports = { register, buildSettingsText, buildSettingsKeyboard };
