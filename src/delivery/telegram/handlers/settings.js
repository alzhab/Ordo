const { Markup } = require('telegraf');
const { getUser, safeEdit, safeDelete } = require('../../../shared/helpers');
const { pendingTasks } = require('../../../shared/state');
const { getCategories, createCategory, getCategoryTaskCount, deleteCategory } = require('../../../application/categories');
const { isConfigured: notionConfigured, isPlansConfigured } = require('../../../infrastructure/integrations/notion');
const { getSyncErrors, clearSyncErrors } = require('../../../application/notifications');
const { getSettings, getNotionEnabled, updateSettings } = require('../../../application/settings');

function buildSettingsText(userId) {
  const s   = getSettings(userId);
  const mt  = s.plan_time   ?? '09:00';
  const et  = s.review_time ?? '21:00';
  const mOn = s.plan_enabled   !== 0;
  const rOn = s.review_enabled !== 0;
  const cats = getCategories(userId);

  return (
    `⚙️ *Настройки*\n\n` +
    `📋 /plan: *${mt}* — ${mOn ? 'включён' : 'выключен'}\n` +
    `🔍 /review: *${et}* — ${rOn ? 'включён' : 'выключен'}\n` +
    `📁 Категорий: *${cats.length}*`
  );
}

function buildSettingsKeyboard(userId) {
  const s   = getSettings(userId);
  const mOn = s.plan_enabled   !== 0;
  const rOn = s.review_enabled !== 0;

  const rows = [
    [
      Markup.button.callback('📋 Время плана',  'sn_mt_change'),
      Markup.button.callback('🔍 Время разбора', 'sn_et_change'),
    ],
    [
      Markup.button.callback(mOn ? '🔕 Выкл. план'  : '🔔 Вкл. план',   'sn_mtoggle'),
      Markup.button.callback(rOn ? '🔕 Выкл. разбор' : '🔔 Вкл. разбор', 'sn_rtoggle'),
    ],
    [Markup.button.callback('📁 Категории', 'settings_categories')],
  ];

  // Notion интеграция скрыта из UI — временно
  // if (notionConfigured()) {
  //   rows.push([Markup.button.callback('🔌 Интеграции', 'settings_integrations')]);
  // }

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
        ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', 'settings_integrations')]]),
      });
    }
    const lines = errors.map(e => `• \`${e.created_at.slice(5, 16)}\` ${e.message}`).join('\n');
    await safeEdit(ctx, `⚠️ *Последние ошибки sync:*\n\n${lines}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🗑 Очистить', 'settings_errors_clear')],
        [Markup.button.callback('◀️ Назад', 'settings_integrations')],
      ]),
    });
  });

  bot.action('settings_errors_clear', async (ctx) => {
    const userId = getUser(ctx);
    clearSyncErrors(userId);
    await ctx.answerCbQuery('🗑 Очищено');
    await renderIntegrationsSettings(ctx, userId, true);
  });

  bot.action('settings_notion_toggle', async (ctx) => {
    const userId = getUser(ctx);
    const enabled = getNotionEnabled(userId);
    updateSettings(userId, { notion_enabled: enabled ? 0 : 1 });
    await ctx.answerCbQuery(enabled ? '🔕 Синхронизация отключена' : '🔔 Синхронизация включена');
    await renderIntegrationsSettings(ctx, userId, true);
  });

  bot.action('settings_back', async (ctx) => {
    const userId = getUser(ctx);
    await ctx.answerCbQuery();
    await safeEdit(ctx, buildSettingsText(userId), { parse_mode: 'Markdown', ...buildSettingsKeyboard(userId) });
  });

  // Интеграции (Notion)
  bot.action('settings_integrations', async (ctx) => {
    const userId = getUser(ctx);
    await ctx.answerCbQuery();
    await renderIntegrationsSettings(ctx, userId, true);
  });

  // Уведомления — открыть (для обратной совместимости с pending-кнопками)
  bot.action('settings_notifications', async (ctx) => {
    const userId = getUser(ctx);
    await ctx.answerCbQuery();
    await safeEdit(ctx, buildSettingsText(userId), { parse_mode: 'Markdown', ...buildSettingsKeyboard(userId) });
  });

  // /plan — запросить время текстом
  bot.action('sn_mt_change', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId) ?? {};
    state.awaitingSettingInput = 'plan_time';
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await safeEdit(ctx, '📋 *В какое время присылать /plan?*\n\nНапример: `9:00` или `в 8 утра`', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('Отмена', 'settings_back')]]),
    });
  });

  // /review — запросить время текстом
  bot.action('sn_et_change', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId) ?? {};
    state.awaitingSettingInput = 'review_time';
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await safeEdit(ctx, '🔍 *В какое время присылать /review?*\n\nНапример: `21:00` или `в 9 вечера`', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('Отмена', 'settings_back')]]),
    });
  });

  // Переключить /plan
  bot.action('sn_mtoggle', async (ctx) => {
    const userId = getUser(ctx);
    const { plan_enabled } = getSettings(userId);
    const next = plan_enabled === 0 ? 1 : 0;
    updateSettings(userId, { plan_enabled: next });
    await ctx.answerCbQuery(next ? '🔔 План включён' : '🔕 План выключен');
    await safeEdit(ctx, buildSettingsText(userId), { parse_mode: 'Markdown', ...buildSettingsKeyboard(userId) });
  });

  // Переключить /review
  bot.action('sn_rtoggle', async (ctx) => {
    const userId = getUser(ctx);
    const { review_enabled } = getSettings(userId);
    const next = review_enabled === 0 ? 1 : 0;
    updateSettings(userId, { review_enabled: next });
    await ctx.answerCbQuery(next ? '🔔 Разбор включён' : '🔕 Разбор выключен');
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

// ─── Интеграции (Notion) ──────────────────────────────────────

function renderIntegrationsSettings(ctx, userId, edit = false) {
  const syncEnabled = getNotionEnabled(userId);
  const notionTasks = notionConfigured() ? '✅ Notion задачи' : '❌ Notion задачи не настроен';
  const notionPlans = isPlansConfigured() ? '✅ Notion планы'  : '❌ Notion планы не настроены';

  const text =
    `🔌 *Интеграции*\n\n` +
    `${notionTasks}\n${notionPlans}\n` +
    `Синхронизация: ${syncEnabled ? 'включена' : 'выключена'}`;

  const rows = [];
  if (notionConfigured()) {
    rows.push([Markup.button.callback(
      syncEnabled ? '🔕 Отключить синхронизацию' : '🔔 Включить синхронизацию',
      'settings_notion_toggle'
    )]);
    if (syncEnabled) {
      rows.push([Markup.button.callback('🔄 Синхронизировать задачи → Notion', 'notion_sync_all')]);
    }
    rows.push([Markup.button.callback('⚠️ Ошибки синхронизации', 'settings_sync_errors')]);
  }
  rows.push([Markup.button.callback('◀️ Назад', 'settings_back')]);

  const opts = { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) };
  return edit ? safeEdit(ctx, text, opts) : ctx.reply(text, opts);
}

async function renderCategoryList(ctx, userId, edit = false) {
  const cats = getCategories(userId);
  const rows = cats.map(c => [Markup.button.callback(`📁 ${c.name}`, `scat_view_${c.id}`)]);
  rows.push([Markup.button.callback('➕ Добавить категорию', 'scat_add')]);
  const text = `📁 *Категории* (${cats.length}):`;
  const opts = { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) };
  return edit ? ctx.editMessageText(text, opts) : ctx.reply(text, opts);
}

module.exports = { register, buildSettingsText, buildSettingsKeyboard, renderIntegrationsSettings };
