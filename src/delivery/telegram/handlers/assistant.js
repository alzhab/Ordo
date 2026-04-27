const { Markup } = require('telegraf');
const { getUser, localNow } = require('../../../shared/helpers');
const { getPlanRecommendations, getReviewData, invalidatePlanCache } = require('../../../application/assistant');
const { isQuietMode, getSettings } = require('../../../application/settings');
const { getTaskById, updateTask, deleteTask, getTasksByPlannedDate, advanceRecurring } = require('../../../application/tasks');
const { pendingTasks } = require('../../../shared/state');
const { safeEdit } = require('../../../shared/helpers');
const { formatTaskDetail, formatTaskText } = require('../formatters');

const PAGE_SIZE = 6;

// ─── Helpers ──────────────────────────────────────────────────

function daysSince(dateStr) {
  if (!dateStr) return 0;
  const d = new Date(dateStr.slice(0, 10));
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

// ─── Calendar picker ─────────────────────────────────────────

const CAL_MONTH_NAMES = [
  'Январь','Февраль','Март','Апрель','Май','Июнь',
  'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь',
];

function buildCalendarKeyboard(year, month, {
  pickPrefix  = 'cal_pick_',
  navPrefix   = 'cal_nav_',
  noopAction  = 'cal_noop',
  closeAction = 'cal_close',
  closeLabel  = '✖️ К плану',
} = {}) {
  const todayStr = new Date().toISOString().split('T')[0];
  const [ty, tm] = todayStr.split('-').map(Number);

  const [pY, pM] = month === 1  ? [year - 1, 12]     : [year, month - 1];
  const [nY, nM] = month === 12 ? [year + 1, 1]      : [year, month + 1];
  const pStr = `${pY}_${String(pM).padStart(2, '0')}`;
  const nStr = `${nY}_${String(nM).padStart(2, '0')}`;

  const canPrev = pY > ty || (pY === ty && pM >= tm - 1);
  const canNext = nY < ty || (nY === ty && nM <= tm + 3) || (nY === ty + 1 && tm >= 10);

  const navRow = [
    Markup.button.callback(canPrev ? '◀️' : ' ', canPrev ? `${navPrefix}${pStr}` : noopAction),
    Markup.button.callback(`${CAL_MONTH_NAMES[month - 1]} ${year}`, noopAction),
    Markup.button.callback(canNext ? '▶️' : ' ', canNext ? `${navPrefix}${nStr}` : noopAction),
  ];

  const headerRow = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс']
    .map(d => Markup.button.callback(d, noopAction));

  const firstDow    = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells = [
    ...Array(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(
      cells.slice(i, i + 7).map(day => {
        if (!day) return Markup.button.callback(' ', noopAction);
        const ds = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        const past    = ds < todayStr;
        const isToday = ds === todayStr;
        const label   = isToday ? `·${day}·` : String(day);
        return past
          ? Markup.button.callback(label, noopAction)
          : Markup.button.callback(label, `${pickPrefix}${ds}`);
      })
    );
  }

  return Markup.inlineKeyboard([
    navRow, headerRow, ...weeks,
    [Markup.button.callback(closeLabel, closeAction)],
  ]);
}

// ─── /plan ───────────────────────────────────────────────────

function formatDateLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const days = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  const months = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;
}

function localDatePlusDays(timezone, n) {
  const today = localNow(timezone);
  const d = new Date(today + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

// Ближайшая пятница (если сегодня пятница — следующая)
function localEndOfWeek(timezone) {
  const today = localNow(timezone);
  const d = new Date(today + 'T00:00:00');
  const daysUntilFriday = ((5 - d.getDay()) + 7) % 7 || 7;
  d.setDate(d.getDate() + daysUntilFriday);
  return d.toISOString().split('T')[0];
}

async function handlePlan(ctx) {
  const userId = getUser(ctx);
  const tz = getSettings(userId).timezone;
  await handlePlanForDate(ctx, localNow(tz));
}

async function handlePlanForDate(ctx, date) {
  const userId = ctx.from.id;
  const planned = getTasksByPlannedDate(userId, date);

  const state = pendingTasks.get(userId) ?? {};
  state.planData = {
    date,
    plannedIds:  planned.map(t => t.id),
    suggestions: null,  // null = не загружены; [] = загружены, пусто
  };
  pendingTasks.set(userId, state);

  await renderPlanSummary(ctx, userId);
}

async function renderPlanSummary(ctx, userId) {
  const { planData } = pendingTasks.get(userId) ?? {};
  if (!planData) return;
  const { date, plannedIds, suggestions } = planData;
  const dateLabel = formatDateLabel(date);

  const lines   = [`📅 *План на ${dateLabel}*\n`];
  const buttons = [];

  if (plannedIds.length) {
    lines.push(`✅ Запланировано: *${plannedIds.length}*`);
    buttons.push([Markup.button.callback(`📋 Запланировано (${plannedIds.length})`, 'plan_open_planned')]);
  }

  // suggestions=null — ещё не запрашивали AI; показываем кнопку без счётчика
  // suggestions=[] — AI вернул пусто; кнопку не показываем
  // suggestions=[...] — есть рекомендации; показываем со счётчиком
  if (suggestions === null) {
    buttons.push([Markup.button.callback('🤖 Предложения AI', 'plan_open_suggestions')]);
  } else if (suggestions.length > 0) {
    lines.push(`🤖 Рекомендует AI: *${suggestions.length}*`);
    buttons.push([
      Markup.button.callback(`🤖 Рекомендации (${suggestions.length})`, 'plan_open_suggestions'),
      Markup.button.callback('🔄', 'plan_refresh_suggestions'),
    ]);
  } else {
    // suggestions=[] — пусто, но можно обновить
    buttons.push([Markup.button.callback('🤖 Обновить предложения', 'plan_refresh_suggestions')]);
  }

  if (!plannedIds.length && suggestions !== null && suggestions.length === 0) {
    lines.push('_Задач нет. Напиши или скажи что нужно сделать — я запишу._');
  }

  buttons.push([Markup.button.callback('📅 Другой день', 'plan_pick_date')]);

  const opts = { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) };
  if (ctx.callbackQuery) {
    await safeEdit(ctx, lines.join('\n'), opts);
  } else {
    await ctx.reply(lines.join('\n'), opts);
  }
}

async function renderPlanList(ctx, userId) {
  const state = pendingTasks.get(userId);
  if (!state?.planData || !state?.planList) return;
  const { category, page } = state.planList;
  const { date, plannedIds, suggestions } = state.planData;

  const rawItems = category === 'planned'
    ? plannedIds.map(id => getTaskById(id)).filter(Boolean)
    : (suggestions ?? []);
  const total = rawItems.length;
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;
  const p = Math.min(page, totalPages - 1);
  state.planList.page = p;
  const pageItems = rawItems.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
  const offset = p * PAGE_SIZE;

  const header = category === 'planned'
    ? `📋 *Запланировано (${total})* — ${formatDateLabel(date)}`
    : `🤖 *Рекомендации AI (${total})*`;

  const taskRows = category === 'planned'
    ? pageItems.map((task, i) => [
        Markup.button.callback(formatTaskText(task, offset + i + 1), `plan_list_item_${task.id}`),
      ])
    : pageItems.map((item, i) => {
        const task = getTaskById(item.id);
        if (!task) return null;
        return [Markup.button.callback(
          `${offset + i + 1}. 🤖 ${task.title}`,
          `plan_list_item_${item.id}`,
        )];
      }).filter(Boolean);

  const extraRows = [];
  if (total > 0) {
    extraRows.push([Markup.button.callback(`▶️ Просмотр (${total})`, 'plan_list_slider')]);
  }
  if (totalPages > 1) {
    extraRows.push([
      Markup.button.callback('◀️', p > 0 ? `plan_list_page_${p - 1}` : 'plan_noop'),
      Markup.button.callback(`${p + 1} / ${totalPages}`, 'plan_noop'),
      Markup.button.callback('▶️', p < totalPages - 1 ? `plan_list_page_${p + 1}` : 'plan_noop'),
    ]);
  }
  extraRows.push([Markup.button.callback('◀️ К плану', 'plan_list_back')]);

  pendingTasks.set(userId, state);
  await safeEdit(ctx, header, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([...taskRows, ...extraRows]) });
}

async function renderPlanSlider(ctx, userId) {
  const state = pendingTasks.get(userId);
  if (!state?.planSlider || !state?.planData) return;
  const { category, index } = state.planSlider;
  const { date, plannedIds, suggestions } = state.planData;
  const total = category === 'planned' ? plannedIds.length : suggestions.length;
  const counter = `_${index + 1} из ${total}_`;
  const nav = [
    Markup.button.callback('◀️', index > 0 ? 'plan_prev' : 'plan_noop'),
    Markup.button.callback('📋 К списку', 'plan_back'),
    Markup.button.callback('▶️', index < total - 1 ? 'plan_next' : 'plan_noop'),
  ];

  if (category === 'planned') {
    if (index >= plannedIds.length) {
      return safeEdit(ctx, '✅ *Запланировано* — просмотрено!', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('📋 К списку', 'plan_back')]]),
      });
    }
    const task = getTaskById(plannedIds[index]);
    if (!task || task.status === 'deleted') {
      state.planSlider.index++;
      pendingTasks.set(userId, state);
      return renderPlanSlider(ctx, userId);
    }
    const tz = getSettings(userId).timezone;
    const detail = formatTaskDetail(task, tz);
    await safeEdit(ctx, `${detail}\n\n${counter}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Сделал', `plan_done_${task.id}`), Markup.button.callback('📅 На завтра', `plan_tomorrow_${task.id}`)],
        [Markup.button.callback('❌ Убрать из плана', `plan_unplan_${task.id}`), Markup.button.callback('🔗 Открыть', `tv_${task.id}`)],
        nav,
      ]),
    });

  } else {
    // suggestions
    if (index >= suggestions.length) {
      return safeEdit(ctx, '✅ *Рекомендации* — просмотрены!', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('📋 К списку', 'plan_back')]]),
      });
    }
    const { id, reason } = suggestions[index];
    const task = getTaskById(id);
    if (!task || task.status === 'deleted') {
      state.planSlider.index++;
      pendingTasks.set(userId, state);
      return renderPlanSlider(ctx, userId);
    }
    const tz = getSettings(userId).timezone;
    const detail = formatTaskDetail(task, tz);
    await safeEdit(ctx, `🤖 _→ ${reason}_\n\n${detail}\n\n${counter}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Добавить в план', `plan_add_${date}_${task.id}`), Markup.button.callback('🔗 Открыть', `tv_${task.id}`)],
        nav,
      ]),
    });
  }
}

// ─── /review ─────────────────────────────────────────────────────

async function handleReview(ctx) {
  const userId = getUser(ctx);
  await renderReviewSummary(ctx, userId, true);
}

async function renderReviewSummary(ctx, userId, reply = false) {
  const { groups, all } = getReviewData(userId);

  if (all.length === 0) {
    const text = '🎉 *Всё под контролем!*\n\nНет задач требующих внимания. Все активные задачи уже запланированы.';
    const opts = {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('📋 Открыть план на сегодня', 'rv_open_plan')]]),
    };
    return reply ? ctx.reply(text, opts) : safeEdit(ctx, text, opts);
  }

  const state = pendingTasks.get(userId) ?? {};
  state.reviewData = {
    groups,
    taskIds: all.map(t => t.id),
    reasons: Object.fromEntries(all.map(t => [t.id, t.reason])),
  };
  delete state.reviewList;
  delete state.reviewSlider;
  pendingTasks.set(userId, state);

  const lines = [`🔍 *Разбор задач* (${all.length})\n`];
  for (const g of groups) {
    lines.push(`${g.label}: ${g.tasks.length}`);
  }

  const buttons = groups.map(g => [
    Markup.button.callback(`${g.label} (${g.tasks.length})`, `rv_group_${g.key}`),
  ]);
  buttons.push([Markup.button.callback(`▶️ Разобрать всё (${all.length})`, 'rv_start')]);

  const text = lines.join('\n');
  const opts = { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) };
  return reply ? ctx.reply(text, opts) : safeEdit(ctx, text, opts);
}

async function renderReviewList(ctx, userId) {
  const state = pendingTasks.get(userId);
  if (!state?.reviewData || !state?.reviewList) return;
  const { groupKey, page } = state.reviewList;
  const { groups, taskIds: allIds, reasons } = state.reviewData;

  let tasks;
  let header;
  if (groupKey === 'all') {
    tasks = allIds.map(id => getTaskById(id)).filter(Boolean);
    header = `📋 *Все задачи (${tasks.length})*`;
  } else {
    const group = groups.find(g => g.key === groupKey);
    if (!group) return;
    tasks = group.tasks.map(t => getTaskById(t.id)).filter(Boolean);
    header = `${group.label} — *${group.tasks.length}*`;
  }

  const total = tasks.length;
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;
  const p = Math.min(page, totalPages - 1);
  state.reviewList.page = p;
  state.reviewList.taskIds = tasks.map(t => t.id);
  const pageItems = tasks.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
  const offset = p * PAGE_SIZE;

  const ICON = { waiting: '⏳', maybe: '💤', todo: '📋', overdue: '⏰' };
  const taskRows = pageItems.map((task, i) => {
    const icon  = ICON[task.status] ?? '📋';
    const label = `${offset + i + 1}. ${icon} ${task.title}`.slice(0, 64);
    return [Markup.button.callback(label, `rv_list_item_${task.id}`)];
  });

  const extraRows = [];
  if (total > 0) {
    extraRows.push([Markup.button.callback(`▶️ Разобрать (${total})`, 'rv_list_slider')]);
  }
  if (totalPages > 1) {
    extraRows.push([
      Markup.button.callback('◀️', p > 0 ? `rv_list_page_${p - 1}` : 'rv_noop'),
      Markup.button.callback(`${p + 1} / ${totalPages}`, 'rv_noop'),
      Markup.button.callback('▶️', p < totalPages - 1 ? `rv_list_page_${p + 1}` : 'rv_noop'),
    ]);
  }
  extraRows.push([Markup.button.callback('◀️ К обзору', 'rv_list_back')]);

  pendingTasks.set(userId, state);
  await safeEdit(ctx, header, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([...taskRows, ...extraRows]),
  });
}

async function renderReviewSlider(ctx, userId) {
  const state = pendingTasks.get(userId);
  if (!state?.reviewSlider) return;
  const { taskIds, reasons, index, stats } = state.reviewSlider;

  if (index >= taskIds.length) {
    const parts = [];
    if (stats.scheduled > 0) parts.push(`📅 Запланировано: ${stats.scheduled}`);
    if (stats.deferred  > 0) parts.push(`⏭ Отложено: ${stats.deferred}`);
    if (stats.deleted   > 0) parts.push(`🗑 Удалено: ${stats.deleted}`);
    const summary = parts.length ? parts.join('\n') : 'Без изменений';
    return safeEdit(ctx, `✅ *Разбор завершён*\n\n${summary}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('📋 Открыть план на сегодня', 'rv_open_plan')]]),
    });
  }

  const task = getTaskById(taskIds[index]);
  if (!task || task.status === 'deleted') {
    state.reviewSlider.index++;
    pendingTasks.set(userId, state);
    return renderReviewSlider(ctx, userId);
  }

  const reason  = reasons[task.id] ?? '';
  const counter = `_${index + 1} из ${taskIds.length}_`;
  const nav = [
    Markup.button.callback('◀️', index > 0 ? 'rv_prev' : 'rv_noop'),
    Markup.button.callback('📋 К обзору', 'rv_back'),
    Markup.button.callback('▶️', index < taskIds.length - 1 ? 'rv_next' : 'rv_noop'),
  ];

  const tz = getSettings(userId).timezone;
  const detail = formatTaskDetail(task, tz);
  const text = `🔍 *Разбор задач* ${counter}\n\n${detail}\n_${reason}_\n\nКогда займёшься?`;
  await safeEdit(ctx, text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('Сегодня',        `rv_today_${task.id}`),
        Markup.button.callback('Завтра',          `rv_tomorrow_${task.id}`),
        Markup.button.callback('На этой неделе', `rv_week_${task.id}`),
      ],
      [Markup.button.callback('📅 Выбрать дату', `rv_pick_date_${task.id}`)],
      [
        Markup.button.callback('⏭ Отложить',      `rv_maybe_${task.id}`),
        Markup.button.callback('🗑 Удалить',       `rv_del_${task.id}`),
      ],
      nav,
    ]),
  });
}

// ─── Кнопки ──────────────────────────────────────────────────


function register(bot) {
  bot.command('plan', handlePlan);
  bot.command('morning', handlePlan); // backwards compat
  bot.command('review', handleReview);

  // Morning — старый выбор даты (для обратной совместимости с pending сообщениями)
  bot.action(/^mplan_(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    getUser(ctx);
    await ctx.answerCbQuery();
    await handlePlanForDate(ctx, ctx.match[1]);
  });

  // Calendar — открыть пикер для текущего месяца
  bot.action('plan_pick_date', async (ctx) => {
    await ctx.answerCbQuery();
    const now = new Date();
    await safeEdit(ctx, '📅 *Выбери день:*', {
      parse_mode: 'Markdown',
      ...buildCalendarKeyboard(now.getFullYear(), now.getMonth() + 1),
    });
  });

  // Calendar — навигация по месяцам
  bot.action(/^cal_nav_(\d{4})_(\d{2})$/, async (ctx) => {
    const year  = parseInt(ctx.match[1]);
    const month = parseInt(ctx.match[2]);
    await ctx.answerCbQuery();
    await safeEdit(ctx, '📅 *Выбери день:*', {
      parse_mode: 'Markdown',
      ...buildCalendarKeyboard(year, month),
    });
  });

  // Calendar — выбор дня → загрузить план
  bot.action(/^cal_pick_(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    await ctx.answerCbQuery();
    await handlePlanForDate(ctx, ctx.match[1]);
  });

  // Calendar — заглушка для нажатия на пустые ячейки
  bot.action('cal_noop', ctx => ctx.answerCbQuery());

  // Calendar — закрыть, вернуться к плану
  bot.action('cal_close', async (ctx) => {
    const userId = getUser(ctx);
    await ctx.answerCbQuery();
    await renderPlanSummary(ctx, userId);
  });

  // Plan — открыть запланированные (список)
  bot.action('plan_open_planned', async (ctx) => {
    const userId = getUser(ctx);
    let state = pendingTasks.get(userId) ?? {};
    if (!state.planData) {
      const today = localNow(getSettings(userId).timezone);
      const planned = getTasksByPlannedDate(userId, today);
      state.planData = { date: today, plannedIds: planned.map(t => t.id), suggestions: null };
    }
    if (!state.planData.plannedIds?.length) return ctx.answerCbQuery('Задач нет');
    state.planList = { category: 'planned', page: 0 };
    delete state.planSlider;
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await renderPlanList(ctx, userId);
  });

  // Plan — открыть AI-рекомендации (lazy-load)
  bot.action('plan_open_suggestions', async (ctx) => {
    const userId = getUser(ctx);
    let state = pendingTasks.get(userId) ?? {};
    if (!state.planData) {
      const today = localNow(getSettings(userId).timezone);
      const planned = getTasksByPlannedDate(userId, today);
      state.planData = { date: today, plannedIds: planned.map(t => t.id), suggestions: null };
      pendingTasks.set(userId, state);
    }

    // Если рекомендации ещё не загружены — загружаем сейчас
    if (state.planData.suggestions === null) {
      await ctx.answerCbQuery();
      await safeEdit(ctx, `⏳ _Анализирую задачи..._`, { parse_mode: 'Markdown' });
      try {
        const items = await getPlanRecommendations(userId, state.planData.date);
        state.planData.suggestions = items
          .map(({ id, reason }) => getTaskById(id) ? { id, reason } : null)
          .filter(Boolean);
      } catch (e) {
        console.error('[plan] AI error:', e.message);
        state.planData.suggestions = [];
        pendingTasks.set(userId, state);
        return safeEdit(ctx, '⚠️ AI недоступен — попробуй позже.', {
          ...Markup.inlineKeyboard([[Markup.button.callback('◀️ К плану', 'plan_back')]]),
        });
      }
      pendingTasks.set(userId, state);
    }

    if (!state.planData.suggestions.length) {
      return safeEdit(ctx, '✅ Нет дополнительных рекомендаций — план выглядит хорошо!', {
        ...Markup.inlineKeyboard([[Markup.button.callback('◀️ К плану', 'plan_list_back')]]),
      });
    }

    state.planList = { category: 'suggestions', page: 0 };
    delete state.planSlider;
    pendingTasks.set(userId, state);
    await renderPlanList(ctx, userId);
  });

  // Plan — принудительно обновить AI рекомендации (сбросить кэш)
  bot.action('plan_refresh_suggestions', async (ctx) => {
    const userId = getUser(ctx);
    let state = pendingTasks.get(userId) ?? {};
    if (!state.planData) {
      const today = localNow(getSettings(userId).timezone);
      const planned = getTasksByPlannedDate(userId, today);
      state.planData = { date: today, plannedIds: planned.map(t => t.id), suggestions: null };
    }
    state.planData.suggestions = null;
    delete state.planList;
    delete state.planSlider;
    pendingTasks.set(userId, state);
    invalidatePlanCache(userId, state.planData.date);
    await ctx.answerCbQuery('🔄 Обновляю...');
    await safeEdit(ctx, '⏳ _Анализирую задачи..._', { parse_mode: 'Markdown' });
    try {
      const items = await getPlanRecommendations(userId, state.planData.date, { forceRefresh: true });
      state.planData.suggestions = items
        .map(({ id, reason }) => getTaskById(id) ? { id, reason } : null)
        .filter(Boolean);
    } catch (e) {
      console.error('[plan] AI refresh error:', e.message);
      state.planData.suggestions = [];
      pendingTasks.set(userId, state);
      return safeEdit(ctx, '⚠️ AI недоступен — попробуй позже.', {
        ...Markup.inlineKeyboard([[Markup.button.callback('◀️ К плану', 'plan_list_back')]]),
      });
    }
    pendingTasks.set(userId, state);
    await renderPlanSummary(ctx, userId);
  });

  // Plan — вернуться к списку из слайдера
  bot.action('plan_back', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId);
    if (!state?.planData) return ctx.answerCbQuery('Сессия устарела');
    delete state.planSlider;
    // Обновляем запланированные из БД при выходе из planned-слайдера
    const planned = getTasksByPlannedDate(userId, state.planData.date);
    state.planData.plannedIds = planned.map(t => t.id);
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    if (state.planList) {
      await renderPlanList(ctx, userId);
    } else {
      await renderPlanSummary(ctx, userId);
    }
  });

  // Plan — вернуться к сводке из списка
  bot.action('plan_list_back', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId);
    if (!state?.planData) return ctx.answerCbQuery('Сессия устарела');
    delete state.planList;
    delete state.planSlider;
    const planned = getTasksByPlannedDate(userId, state.planData.date);
    state.planData.plannedIds = planned.map(t => t.id);
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await renderPlanSummary(ctx, userId);
  });

  // Plan — открыть слайдер из списка (с начала)
  bot.action('plan_list_slider', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId);
    if (!state?.planList) return ctx.answerCbQuery();
    state.planSlider = { category: state.planList.category, index: 0 };
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await renderPlanSlider(ctx, userId);
  });

  // Plan — открыть слайдер на конкретной задаче
  bot.action(/^plan_list_item_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const taskId = parseInt(ctx.match[1]);
    const state  = pendingTasks.get(userId);
    if (!state?.planList || !state?.planData) return ctx.answerCbQuery();
    const { category } = state.planList;
    const { plannedIds, suggestions } = state.planData;
    const index = category === 'planned'
      ? plannedIds.indexOf(taskId)
      : suggestions.findIndex(s => s.id === taskId);
    state.planSlider = { category, index: Math.max(0, index) };
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await renderPlanSlider(ctx, userId);
  });

  // Plan — пагинация списка
  bot.action(/^plan_list_page_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId);
    if (!state?.planList) return ctx.answerCbQuery();
    state.planList.page = parseInt(ctx.match[1]);
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await renderPlanList(ctx, userId);
  });

  // Plan — навигация по слайдеру
  bot.action('plan_next', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId);
    if (!state?.planSlider) return ctx.answerCbQuery();
    state.planSlider.index++;
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await renderPlanSlider(ctx, userId);
  });
  bot.action('plan_prev', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId);
    if (!state?.planSlider) return ctx.answerCbQuery();
    state.planSlider.index = Math.max(0, state.planSlider.index - 1);
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await renderPlanSlider(ctx, userId);
  });
  bot.action('plan_noop', ctx => ctx.answerCbQuery());

  // Plan — действия над задачей
  function planAction(fn, toast) {
    return async (ctx) => {
      const userId = getUser(ctx);
      const id     = parseInt(ctx.match[1]);
      fn(id, userId);
      await ctx.answerCbQuery(toast);
      const state = pendingTasks.get(userId);
      if (state?.planSlider) {
        state.planSlider.index++;
        pendingTasks.set(userId, state);
        await renderPlanSlider(ctx, userId);
      }
    };
  }

  bot.action(/^plan_done_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const id     = parseInt(ctx.match[1]);
    const task   = getTaskById(id);
    if (task?.is_recurring) {
      advanceRecurring(id);
      await ctx.answerCbQuery('🔄 Цикл обновлён');
    } else {
      updateTask(id, { status: 'done' }, userId);
      await ctx.answerCbQuery('✅ Готово');
    }
    const state = pendingTasks.get(userId);
    if (state?.planSlider) {
      state.planSlider.index++;
      pendingTasks.set(userId, state);
      await renderPlanSlider(ctx, userId);
    }
  });
  bot.action(/^plan_tomorrow_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const id     = parseInt(ctx.match[1]);
    const tomorrow = localDatePlusDays(getSettings(userId).timezone, 1);
    updateTask(id, { planned_for: tomorrow }, userId);
    await ctx.answerCbQuery('📅 На завтра');
    const state = pendingTasks.get(userId);
    if (state?.planSlider) {
      state.planSlider.index++;
      pendingTasks.set(userId, state);
      await renderPlanSlider(ctx, userId);
    }
  });
  bot.action(/^plan_unplan_(\d+)$/,  planAction((id, uid) => updateTask(id, { planned_for: null }, uid),    '❌ Убрано из плана'));

  // Plan — добавить рекомендацию в план (обновляет и переходит к следующей)
  bot.action(/^plan_add_(\d{4}-\d{2}-\d{2})_(\d+)$/, async (ctx) => {
    const date   = ctx.match[1];
    const taskId = parseInt(ctx.match[2]);
    const userId = getUser(ctx);
    updateTask(taskId, { planned_for: date }, userId);
    await ctx.answerCbQuery('➕ Добавлено в план');
    const state = pendingTasks.get(userId);
    if (state?.planSlider) {
      // Обновляем список запланированных и убираем из suggestions
      state.planData.suggestions = state.planData.suggestions.filter(s => s.id !== taskId);
      const planned = getTasksByPlannedDate(userId, date);
      state.planData.plannedIds = planned.map(t => t.id);
      // Не смещаем index — следующая рекомендация сдвинется на то же место
      pendingTasks.set(userId, state);
      await renderPlanSlider(ctx, userId);
    }
  });

  // Review — начать разбор всех задач (слайдер)
  bot.action('rv_start', async (ctx) => {
    const userId = getUser(ctx);
    let state = pendingTasks.get(userId) ?? {};
    if (!state.reviewData) {
      const { groups, all } = getReviewData(userId);
      state.reviewData = {
        groups,
        taskIds: all.map(t => t.id),
        reasons: Object.fromEntries(all.map(t => [t.id, t.reason])),
      };
    }
    if (!state.reviewData.taskIds.length) return ctx.answerCbQuery('Задач нет');
    state.reviewSlider = {
      taskIds: state.reviewData.taskIds,
      reasons: state.reviewData.reasons,
      index: 0,
      stats: { scheduled: 0, deferred: 0, deleted: 0 },
    };
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await renderReviewSlider(ctx, userId);
  });

  // Review — открыть план на сегодня
  bot.action('rv_open_plan', async (ctx) => {
    const userId = getUser(ctx);
    await ctx.answerCbQuery();
    await handlePlanForDate(ctx, localNow(getSettings(userId).timezone));
  });

  // Review — назад из слайдера (к группе-списку или к обзору)
  bot.action('rv_back', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId) ?? {};
    delete state.reviewSlider;
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    if (state.reviewList) {
      await renderReviewList(ctx, userId);
    } else {
      await renderReviewSummary(ctx, userId);
    }
  });

  // Review — открыть группу задач (список)
  bot.action(/^rv_group_(\w+)$/, async (ctx) => {
    const userId   = getUser(ctx);
    const groupKey = ctx.match[1];
    const state    = pendingTasks.get(userId) ?? {};
    if (!state.reviewData) return ctx.answerCbQuery('Сессия устарела');
    state.reviewList = { groupKey, page: 0 };
    delete state.reviewSlider;
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await renderReviewList(ctx, userId);
  });

  // Review list — пагинация
  bot.action(/^rv_list_page_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId);
    if (!state?.reviewList) return ctx.answerCbQuery();
    state.reviewList.page = parseInt(ctx.match[1]);
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await renderReviewList(ctx, userId);
  });

  // Review list — открыть задачу в слайдере
  bot.action(/^rv_list_item_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const taskId = parseInt(ctx.match[1]);
    const state  = pendingTasks.get(userId);
    if (!state?.reviewList || !state?.reviewData) return ctx.answerCbQuery();
    const taskIds = state.reviewList.taskIds ?? state.reviewData.taskIds;
    const index   = taskIds.indexOf(taskId);
    state.reviewSlider = {
      taskIds,
      reasons: state.reviewData.reasons,
      index: Math.max(0, index),
      stats: { scheduled: 0, deferred: 0, deleted: 0 },
    };
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await renderReviewSlider(ctx, userId);
  });

  // Review list — открыть слайдер с начала текущей группы
  bot.action('rv_list_slider', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId);
    if (!state?.reviewList || !state?.reviewData) return ctx.answerCbQuery();
    const taskIds = state.reviewList.taskIds ?? state.reviewData.taskIds;
    state.reviewSlider = {
      taskIds,
      reasons: state.reviewData.reasons,
      index: 0,
      stats: { scheduled: 0, deferred: 0, deleted: 0 },
    };
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await renderReviewSlider(ctx, userId);
  });

  // Review list — назад к обзору (summary)
  bot.action('rv_list_back', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId) ?? {};
    delete state.reviewList;
    delete state.reviewSlider;
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await renderReviewSummary(ctx, userId);
  });

  // Review — навигация по слайдеру
  bot.action('rv_next', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId);
    if (!state?.reviewSlider) return ctx.answerCbQuery();
    state.reviewSlider.index++;
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await renderReviewSlider(ctx, userId);
  });
  bot.action('rv_prev', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId);
    if (!state?.reviewSlider) return ctx.answerCbQuery();
    state.reviewSlider.index = Math.max(0, state.reviewSlider.index - 1);
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await renderReviewSlider(ctx, userId);
  });
  bot.action('rv_noop', ctx => ctx.answerCbQuery());

  // Review — запланировать на сегодня
  bot.action(/^rv_today_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const id     = parseInt(ctx.match[1]);
    updateTask(id, { planned_for: localNow(getSettings(userId).timezone) }, userId);
    await ctx.answerCbQuery('📅 На сегодня');
    const state = pendingTasks.get(userId);
    if (state?.reviewSlider) {
      state.reviewSlider.stats.scheduled++;
      state.reviewSlider.index++;
      pendingTasks.set(userId, state);
    }
    await renderReviewSlider(ctx, userId);
  });

  // Review — запланировать на завтра
  bot.action(/^rv_tomorrow_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const id     = parseInt(ctx.match[1]);
    updateTask(id, { planned_for: localDatePlusDays(getSettings(userId).timezone, 1) }, userId);
    await ctx.answerCbQuery('📅 На завтра');
    const state = pendingTasks.get(userId);
    if (state?.reviewSlider) {
      state.reviewSlider.stats.scheduled++;
      state.reviewSlider.index++;
      pendingTasks.set(userId, state);
    }
    await renderReviewSlider(ctx, userId);
  });

  // Review — запланировать на эту неделю (ближайшая пятница)
  bot.action(/^rv_week_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const id     = parseInt(ctx.match[1]);
    updateTask(id, { planned_for: localEndOfWeek(getSettings(userId).timezone) }, userId);
    await ctx.answerCbQuery('📅 На эту неделю');
    const state = pendingTasks.get(userId);
    if (state?.reviewSlider) {
      state.reviewSlider.stats.scheduled++;
      state.reviewSlider.index++;
      pendingTasks.set(userId, state);
    }
    await renderReviewSlider(ctx, userId);
  });

  // Review — отложить на неделю (статус maybe)
  bot.action(/^rv_maybe_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const id     = parseInt(ctx.match[1]);
    updateTask(id, { status: 'maybe' }, userId);
    await ctx.answerCbQuery('⏭ Отложено');
    const state = pendingTasks.get(userId);
    if (state?.reviewSlider) {
      state.reviewSlider.stats.deferred++;
      state.reviewSlider.index++;
      pendingTasks.set(userId, state);
    }
    await renderReviewSlider(ctx, userId);
  });

  // Review — удалить
  bot.action(/^rv_del_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const id     = parseInt(ctx.match[1]);
    deleteTask(id, userId);
    await ctx.answerCbQuery('🗑 Удалено');
    const state = pendingTasks.get(userId);
    if (state?.reviewSlider) {
      state.reviewSlider.stats.deleted++;
      state.reviewSlider.index++;
      pendingTasks.set(userId, state);
    }
    await renderReviewSlider(ctx, userId);
  });

  // Review — открыть календарь для выбора даты
  bot.action(/^rv_pick_date_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const taskId = parseInt(ctx.match[1]);
    const state  = pendingTasks.get(userId) ?? {};
    state.reviewCalTaskId = taskId;
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    const now = new Date();
    await safeEdit(ctx, '📅 *Выбери дату:*', {
      parse_mode: 'Markdown',
      ...buildCalendarKeyboard(now.getFullYear(), now.getMonth() + 1, {
        pickPrefix:  'rvcal_pick_',
        navPrefix:   'rvcal_nav_',
        noopAction:  'rvcal_noop',
        closeAction: 'rvcal_close',
        closeLabel:  '✖️ К задаче',
      }),
    });
  });

  // Review calendar — навигация по месяцам
  bot.action(/^rvcal_nav_(\d{4})_(\d{2})$/, async (ctx) => {
    const year  = parseInt(ctx.match[1]);
    const month = parseInt(ctx.match[2]);
    await ctx.answerCbQuery();
    await safeEdit(ctx, '📅 *Выбери дату:*', {
      parse_mode: 'Markdown',
      ...buildCalendarKeyboard(year, month, {
        pickPrefix:  'rvcal_pick_',
        navPrefix:   'rvcal_nav_',
        noopAction:  'rvcal_noop',
        closeAction: 'rvcal_close',
        closeLabel:  '✖️ К задаче',
      }),
    });
  });

  // Review calendar — выбор даты → запланировать и перейти к следующей
  bot.action(/^rvcal_pick_(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    const date   = ctx.match[1];
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId);
    const taskId = state?.reviewCalTaskId;
    if (!taskId) return ctx.answerCbQuery('Сессия устарела');
    updateTask(taskId, { planned_for: date }, userId);
    delete state.reviewCalTaskId;
    await ctx.answerCbQuery(`📅 Запланировано на ${date}`);
    if (state.reviewSlider) {
      state.reviewSlider.stats.scheduled++;
      state.reviewSlider.index++;
      pendingTasks.set(userId, state);
      await renderReviewSlider(ctx, userId);
    }
  });

  // Review calendar — закрыть, вернуться к задаче
  bot.action('rvcal_close', async (ctx) => {
    const userId = getUser(ctx);
    await ctx.answerCbQuery();
    await renderReviewSlider(ctx, userId);
  });

  // Review calendar — заглушка
  bot.action('rvcal_noop', ctx => ctx.answerCbQuery());

  // "✅ Сделал" из уведомления повторяющейся задачи.
  // advanceRecurring уже вызван при отправке — просто убираем кнопку.
  bot.action(/^rc_done_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery('✅ Отмечено');
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  });

}

module.exports = { register, handlePlan, handleReview };
