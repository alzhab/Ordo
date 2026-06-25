const { Markup } = require('telegraf');
const { getUser, safeEdit, safeDelete } = require('../../../shared/helpers');
const { pendingTasks, aliceLinkCodes } = require('../../../shared/state');
const { getCategories, createCategory, getCategoryTaskCount, deleteCategory } = require('../../../application/categories');
const { isConfigured: notionConfigured, isPlansConfigured } = require('../../../infrastructure/integrations/notion');
const gcal  = require('../../../infrastructure/integrations/googleCalendar');
const { getSyncErrors, clearSyncErrors } = require('../../../application/notifications');
const { getSettings, getNotionEnabled, updateSettings, getGcalColors, updateGcalColors } = require('../../../application/settings');
const { syncAllToCalendar, getUnsyncedCalendarTasks, syncColorForType } = require('../../../application/tasks');
const { getAliceUserId, setAliceUserId } = require('../../../infrastructure/db/repositories/userRepository');

const REMINDER_COUNT_LABELS = { 0: 'выкл.', 1: '1 раз', 2: '2 раза', 4: '4 раза', 8: '8 раз' };
const REMINDER_BEFORE_LABELS = { 15: '15 мин', 30: '30 мин', 60: '1 час', 120: '2 часа' };

function buildSettingsText(userId) {
  const s   = getSettings(userId);
  const mt  = s.plan_time   ?? '09:00';
  const et  = s.review_time ?? '21:00';
  const mOn = s.plan_enabled   !== 0;
  const rOn = s.review_enabled !== 0;
  const cats = getCategories(userId);
  const remCount  = s.daily_reminder_count  ?? 1;
  const remBefore = s.default_reminder_before ?? 30;

  return (
    `⚙️ *Настройки*\n\n` +
    `📋 /plan: *${mt}* — ${mOn ? 'включён' : 'выключен'}\n` +
    `🔍 /review: *${et}* — ${rOn ? 'включён' : 'выключен'}\n` +
    `🔔 Напоминания: *${REMINDER_COUNT_LABELS[remCount] ?? remCount}* в день, за *${REMINDER_BEFORE_LABELS[remBefore] ?? remBefore + ' мин'}*\n` +
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
    [Markup.button.callback('🔔 Напоминания', 'settings_reminders')],
  ];

  if (gcal.isConfigured()) {
    let gcalLabel = '📅 Google Calendar';
    if (gcal.needsReconnect(userId)) gcalLabel = '📅 Google Calendar ⚠️';
    else if (gcal.isConnected(userId))  gcalLabel = '📅 Google Calendar ✅';
    rows.push([Markup.button.callback(gcalLabel, 'settings_gcal')]);
  }

  const aliceLabel = getAliceUserId(userId) ? '🎙 Алиса ✅' : '🎙 Алиса';
  rows.push([Markup.button.callback(aliceLabel, 'settings_alice')]);

  return Markup.inlineKeyboard(rows);
}

// Палитра Google Calendar: colorId → { emoji, name }
const GCAL_COLORS = {
  1:  { emoji: '💜', name: 'Лаванда'   },
  2:  { emoji: '🌿', name: 'Шалфей'    },
  3:  { emoji: '🍇', name: 'Виноград'  },
  4:  { emoji: '🌸', name: 'Фламинго'  },
  5:  { emoji: '🍌', name: 'Банан'     },
  6:  { emoji: '🍊', name: 'Мандарин'  },
  7:  { emoji: '🦚', name: 'Павлин'    },
  8:  { emoji: '🫐', name: 'Черника'   },
  9:  { emoji: '🌱', name: 'Базилик'   },
  10: { emoji: '🍅', name: 'Томат'     },
  11: { emoji: '🩷', name: 'Розовый'   },
};

const GCAL_TASK_TYPES = {
  all_day:   { label: '📅 Весь день'        },
  timed:     { label: '⏰ С временем'        },
  recurring: { label: '🔄 Повторяющиеся'    },
};

function colorLabel(colorId) {
  if (!colorId) return '⬜ По умолчанию';
  const c = GCAL_COLORS[colorId];
  return c ? `${c.emoji} ${c.name}` : '⬜ По умолчанию';
}

function buildGCalText(userId) {
  const connected     = gcal.isConnected(userId);
  const needReconnect = gcal.needsReconnect(userId);
  const email         = gcal.getConnectedEmail(userId);
  let text = `📅 *Google Calendar*\n\n`;
  if (needReconnect) {
    text += `⚠️ *Требуется переподключение*`;
    if (email) text += ` (${email})`;
    text += `\n\nТокен получен без разрешения на запись в Calendar. Отключи и подключи снова — Google попросит подтвердить доступ заново.`;
  } else if (connected) {
    const calErrors = getSyncErrors(userId).filter(e => e.message.includes('Calendar'));
    const hasAuthError = calErrors.some(e => e.message.includes('переподключить'));
    if (hasAuthError) {
      text += `⚠️ *Требуется переподключение*`;
      if (email) text += ` (${email})`;
      text += `\n\nТокен Google Calendar был отозван. Отключи и подключи снова.`;
    } else {
      text += `✅ Подключён`;
      if (email) text += ` (${email})`;
      text += `\n\nЗадачи с датой автоматически синхронизируются с твоим Google Calendar.`;
      text += `\nСобытия из календаря отображаются в /plan.`;
      const colors = getGcalColors(userId);
      text += `\n\n🎨 *Цвета событий:*\n`;
      for (const [type, { label }] of Object.entries(GCAL_TASK_TYPES)) {
        text += `${label}: ${colorLabel(colors[type])}\n`;
      }
      if (calErrors.length) {
        text += `\n⚠️ *Последние ошибки:*\n`;
        text += calErrors.slice(0, 3).map(e => `• \`${e.created_at.slice(5, 16)}\` ${e.message}`).join('\n');
      }
    }
  } else {
    text += `❌ Не подключён\n\nПодключи Google Calendar — задачи с датой будут автоматически появляться в твоём календаре, а события из календаря — в /plan.`;
  }
  return text;
}

function buildGCalKeyboard(userId) {
  const connected     = gcal.isConnected(userId);
  const needReconnect = gcal.needsReconnect(userId);
  const authUrl       = gcal.generateAuthUrl(userId);
  const rows = [];
  if (needReconnect) {
    rows.push([Markup.button.callback('🔌 Отключить', 'gcal_disconnect')]);
    rows.push([Markup.button.url('🔗 Подключить заново', authUrl)]);
  } else if (connected) {
    const hasAuthError = getSyncErrors(userId)
      .some(e => e.message.includes('Calendar') && e.message.includes('переподключить'));
    if (hasAuthError) {
      rows.push([Markup.button.callback('🔌 Отключить', 'gcal_disconnect')]);
      rows.push([Markup.button.url('🔗 Подключить заново', authUrl)]);
    } else {
      const unsynced = getUnsyncedCalendarTasks(userId).length;
      if (unsynced > 0) {
        rows.push([Markup.button.callback(`🔄 Синхронизировать задачи (${unsynced})`, 'gcal_sync_all')]);
      }
      rows.push([Markup.button.callback('🎨 Настроить цвета', 'gcal_colors')]);
      rows.push([Markup.button.callback('🔌 Отключить', 'gcal_disconnect')]);
    }
  } else {
    rows.push([Markup.button.url('🔗 Подключить Google Calendar', authUrl)]);
  }
  rows.push([Markup.button.callback('◀️ Назад', 'settings_back')]);
  return Markup.inlineKeyboard(rows);
}

function buildRemindersText(userId) {
  const s = getSettings(userId);
  const count  = s.daily_reminder_count  ?? 1;
  const before = s.default_reminder_before ?? 30;
  return (
    `🔔 *Напоминания о задачах*\n\n` +
    `📋 Задачи без времени: *${REMINDER_COUNT_LABELS[count] ?? count}* в день\n` +
    `⏰ Задачи с временем: за *${REMINDER_BEFORE_LABELS[before] ?? before + ' мин'}* по умолч.\n`
  );
}

function buildRemindersKeyboard(userId) {
  const s     = getSettings(userId);
  const count  = s.daily_reminder_count  ?? 1;
  const before = s.default_reminder_before ?? 30;

  const countRow = [0, 1, 2, 4, 8].map(n =>
    Markup.button.callback(n === count ? `✓ ${REMINDER_COUNT_LABELS[n]}` : (REMINDER_COUNT_LABELS[n] ?? String(n)), `sn_rem_count_${n}`)
  );
  const beforeRow = [15, 30, 60, 120].map(m =>
    Markup.button.callback(m === before ? `✓ ${REMINDER_BEFORE_LABELS[m]}` : REMINDER_BEFORE_LABELS[m], `sn_rem_before_${m}`)
  );

  return Markup.inlineKeyboard([
    countRow,
    beforeRow,
    [Markup.button.callback('◀️ Назад', 'settings_back')],
  ]);
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

  // Раздел «Напоминания о задачах»
  bot.action('settings_reminders', async (ctx) => {
    const userId = getUser(ctx);
    await ctx.answerCbQuery();
    await safeEdit(ctx, buildRemindersText(userId), { parse_mode: 'Markdown', ...buildRemindersKeyboard(userId) });
  });

  bot.action(/^sn_rem_count_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const count  = parseInt(ctx.match[1]);
    updateSettings(userId, { daily_reminder_count: count });
    await ctx.answerCbQuery(`✅ ${REMINDER_COUNT_LABELS[count] ?? count} в день`);
    await safeEdit(ctx, buildRemindersText(userId), { parse_mode: 'Markdown', ...buildRemindersKeyboard(userId) });
  });

  bot.action(/^sn_rem_before_(\d+)$/, async (ctx) => {
    const userId  = getUser(ctx);
    const minutes = parseInt(ctx.match[1]);
    updateSettings(userId, { default_reminder_before: minutes });
    await ctx.answerCbQuery(`✅ За ${REMINDER_BEFORE_LABELS[minutes] ?? minutes + ' мин'}`);
    await safeEdit(ctx, buildRemindersText(userId), { parse_mode: 'Markdown', ...buildRemindersKeyboard(userId) });
  });

  bot.action('settings_back', async (ctx) => {
    const userId = getUser(ctx);
    await ctx.answerCbQuery();
    await safeEdit(ctx, buildSettingsText(userId), { parse_mode: 'Markdown', ...buildSettingsKeyboard(userId) });
  });

  // Google Calendar
  bot.action('settings_gcal', async (ctx) => {
    const userId = getUser(ctx);
    await ctx.answerCbQuery();
    await safeEdit(ctx, buildGCalText(userId), { parse_mode: 'Markdown', ...buildGCalKeyboard(userId) });
  });

  bot.action('gcal_disconnect', async (ctx) => {
    const userId = getUser(ctx);
    gcal.disconnect(userId);
    await ctx.answerCbQuery('🔌 Google Calendar отключён');
    await safeEdit(ctx, buildGCalText(userId), { parse_mode: 'Markdown', ...buildGCalKeyboard(userId) });
  });

  // Экран выбора типа задачи для настройки цвета
  bot.action('gcal_colors', async (ctx) => {
    const userId = getUser(ctx);
    await ctx.answerCbQuery();
    const colors = getGcalColors(userId);
    const rows = Object.entries(GCAL_TASK_TYPES).map(([type, { label }]) => [
      Markup.button.callback(`${label} — ${colorLabel(colors[type])}`, `gcal_color_type_${type}`),
    ]);
    rows.push([Markup.button.callback('◀️ Назад', 'settings_gcal')]);
    await safeEdit(ctx, '🎨 *Цвета событий*\n\nВыбери тип задачи:', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(rows),
    });
  });

  // Палитра цветов для конкретного типа
  bot.action(/^gcal_color_type_(all_day|timed|recurring)$/, async (ctx) => {
    const type   = ctx.match[1];
    const userId = getUser(ctx);
    await ctx.answerCbQuery();
    const { label } = GCAL_TASK_TYPES[type];

    const colorEntries = Object.entries(GCAL_COLORS);
    const rows = [];
    for (let i = 0; i < colorEntries.length; i += 3) {
      rows.push(colorEntries.slice(i, i + 3).map(([id, { emoji, name }]) =>
        Markup.button.callback(`${emoji} ${name}`, `gcal_color_set_${type}_${id}`)
      ));
    }
    rows.push([Markup.button.callback('⬜ По умолчанию', `gcal_color_set_${type}_0`)]);
    rows.push([Markup.button.callback('◀️ Назад', 'gcal_colors')]);

    await safeEdit(ctx, `🎨 *Цвет для "${label}"*\n\nВыбери цвет:`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(rows),
    });
  });

  // Сохранение выбранного цвета
  bot.action(/^gcal_color_set_(all_day|timed|recurring)_(\d+)$/, async (ctx) => {
    const type    = ctx.match[1];
    const colorId = parseInt(ctx.match[2]);
    const userId  = getUser(ctx);
    const colors  = getGcalColors(userId);
    if (colorId === 0) {
      delete colors[type];
    } else {
      colors[type] = colorId;
    }
    updateGcalColors(userId, colors);
    const colorName = colorId === 0 ? 'По умолчанию' : (GCAL_COLORS[colorId]?.name ?? '');
    await ctx.answerCbQuery(`✅ ${colorName}`);
    // Обновляем цвет уже синхронизированных событий этого типа
    syncColorForType(userId, type, colors).catch(() => {});
    // Возвращаемся к списку типов
    const updatedColors = getGcalColors(userId);
    const rows = Object.entries(GCAL_TASK_TYPES).map(([t, { label }]) => [
      Markup.button.callback(`${label} — ${colorLabel(updatedColors[t])}`, `gcal_color_type_${t}`),
    ]);
    rows.push([Markup.button.callback('◀️ Назад', 'settings_gcal')]);
    await safeEdit(ctx, '🎨 *Цвета событий*\n\nВыбери тип задачи:', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(rows),
    });
  });

  bot.action('gcal_sync_all', async (ctx) => {
    const userId = getUser(ctx);
    await ctx.answerCbQuery('🔄 Синхронизирую...');
    await safeEdit(ctx, '⏳ _Синхронизирую задачи с Google Calendar..._', { parse_mode: 'Markdown' });
    try {
      const { synced, failed, total } = await syncAllToCalendar(userId);
      const lines = [`✅ Синхронизация завершена`];
      if (synced)  lines.push(`Добавлено в Calendar: *${synced}*`);
      if (failed)  lines.push(`Ошибок: *${failed}*`);
      if (total === 0) lines.push('_Все задачи уже синхронизированы_');
      await safeEdit(ctx, lines.join('\n'), {
        parse_mode: 'Markdown',
        ...buildGCalKeyboard(userId),
      });
    } catch (e) {
      console.error('[gcal] sync_all error:', e.message);
      await safeEdit(ctx, '⚠️ Ошибка синхронизации. Попробуй позже.', {
        ...buildGCalKeyboard(userId),
      });
    }
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

  // ─── Яндекс Алиса ────────────────────────────────────────

  bot.action('settings_alice', async (ctx) => {
    const userId = getUser(ctx);
    await ctx.answerCbQuery();
    const aliceId = getAliceUserId(userId);
    if (aliceId) {
      await safeEdit(ctx,
        '🎙 *Яндекс Алиса*\n\n✅ Аккаунт привязан.\n\nМожешь говорить задачи Алисе — они появятся здесь.',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔌 Отвязать', 'settings_alice_unlink')],
            [Markup.button.callback('◀️ Назад', 'settings_back')],
          ]),
        }
      );
    } else {
      // Генерируем новый код (старый для этого пользователя инвалидируем)
      for (const [code, data] of aliceLinkCodes.entries()) {
        if (data.userId === userId) aliceLinkCodes.delete(code);
      }
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      aliceLinkCodes.set(code, { userId, expiresAt: Date.now() + 5 * 60 * 1000 });

      await safeEdit(ctx,
        `🎙 *Яндекс Алиса*\n\n` +
        `Чтобы привязать аккаунт:\n\n` +
        `1. Скажи Алисе: _«Алиса, запусти Орdo»_\n` +
        `2. Назови код:\n\n` +
        `*${code}*\n\n` +
        `_Код действителен 5 минут_`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', 'settings_back')]]),
        }
      );
    }
  });

  bot.action('settings_alice_unlink', async (ctx) => {
    const userId = getUser(ctx);
    setAliceUserId(userId, null);
    await ctx.answerCbQuery('🔌 Алиса отвязана');
    await safeEdit(ctx, buildSettingsText(userId), { parse_mode: 'Markdown', ...buildSettingsKeyboard(userId) });
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
