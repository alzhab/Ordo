const { Markup } = require('telegraf');
const { getUser } = require('../../../shared/helpers');
const { getPlanRecommendations, getReviewData } = require('../../../application/assistant');
const { isQuietMode } = require('../../../application/settings');
const { getTaskById, updateTask, deleteTask, getTasksByPlannedDate, snoozeTask, advanceRecurring } = require('../../../application/tasks');
const { pendingTasks } = require('../../../shared/state');
const { safeEdit } = require('../../../shared/helpers');

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

function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

async function handlePlan(ctx) {
  getUser(ctx);
  await handlePlanForDate(ctx, addDays(0));
}

async function handlePlanForDate(ctx, date) {
  const userId = ctx.from.id;
  const loadingText = `⏳ _Анализирую задачи на ${formatDateLabel(date)}..._`;
  if (ctx.callbackQuery) {
    await safeEdit(ctx, loadingText, { parse_mode: 'Markdown' });
  } else {
    ctx._loadingMsg = await ctx.reply(loadingText, { parse_mode: 'Markdown' });
  }

  const planned = getTasksByPlannedDate(userId, date);

  let aiSuggestions = [];
  try {
    const items = await getPlanRecommendations(userId, date);
    aiSuggestions = items
      .map(({ id, reason }) => getTaskById(id) ? { id, reason } : null)
      .filter(Boolean);
  } catch (e) {
    console.error('[plan]', e.message);
  }

  const state = pendingTasks.get(userId) ?? {};
  state.planData = {
    date,
    plannedIds:  planned.map(t => t.id),
    suggestions: aiSuggestions,
    loadingMsgId: ctx._loadingMsg?.message_id ?? null,
  };
  pendingTasks.set(userId, state);

  await renderPlanSummary(ctx, userId);
}

async function renderPlanSummary(ctx, userId) {
  const { planData } = pendingTasks.get(userId) ?? {};
  if (!planData) return;
  const { date, plannedIds, suggestions, loadingMsgId } = planData;
  const dateLabel = formatDateLabel(date);

  const lines   = [`📅 *План на ${dateLabel}*\n`];
  const buttons = [];

  if (plannedIds.length) {
    lines.push(`✅ Запланировано: *${plannedIds.length}*`);
    buttons.push([Markup.button.callback(`📋 Запланировано (${plannedIds.length})`, 'plan_open_planned')]);
  }

  if (suggestions.length) {
    lines.push(`🤖 Рекомендует AI: *${suggestions.length}*`);
    buttons.push([Markup.button.callback(`🤖 Рекомендации (${suggestions.length})`, 'plan_open_suggestions')]);
  }

  if (!plannedIds.length && !suggestions.length) {
    lines.push('_Задач нет. Напиши или скажи что нужно сделать — я запишу._');
  }

  buttons.push([Markup.button.callback('📅 Другой день', 'plan_pick_date')]);

  const opts = { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) };
  if (loadingMsgId) {
    await ctx.telegram.editMessageText(ctx.chat.id, loadingMsgId, null, lines.join('\n'), opts)
      .catch(() => ctx.reply(lines.join('\n'), opts));
  } else {
    await safeEdit(ctx, lines.join('\n'), opts);
  }
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
    Markup.button.callback('📋 К плану', 'plan_back'),
    Markup.button.callback('▶️', 'plan_next'),
  ];

  if (category === 'planned') {
    if (index >= plannedIds.length) {
      return safeEdit(ctx, '✅ *Запланировано* — просмотрено!', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('◀️ К плану', 'plan_back')]]),
      });
    }
    const task = getTaskById(plannedIds[index]);
    if (!task || task.status === 'deleted') {
      state.planSlider.index++;
      pendingTasks.set(userId, state);
      return renderPlanSlider(ctx, userId);
    }
    const statusIcon = task.status === 'done' ? '✅' : '☐';
    await safeEdit(ctx, `${statusIcon} *${task.title}*\n${counter}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Сделал', `plan_done_${task.id}`), Markup.button.callback('📅 На завтра', `plan_tomorrow_${task.id}`)],
        [Markup.button.callback('❌ Убрать из плана', `plan_unplan_${task.id}`)],
        nav,
      ]),
    });

  } else {
    // suggestions
    if (index >= suggestions.length) {
      return safeEdit(ctx, '✅ *Рекомендации* — просмотрены!', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('◀️ К плану', 'plan_back')]]),
      });
    }
    const { id, reason } = suggestions[index];
    const task = getTaskById(id);
    if (!task || task.status === 'deleted') {
      state.planSlider.index++;
      pendingTasks.set(userId, state);
      return renderPlanSlider(ctx, userId);
    }
    await safeEdit(ctx, `🤖 *${task.title}*\n_→ ${reason}_\n${counter}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Добавить в план', `plan_add_${date}_${task.id}`)],
        nav,
      ]),
    });
  }
}

// ─── /review — сводная карточка ──────────────────────────────

const RV_LABELS = {
  unclosed: '📅 Из плана',
  waiting:  '⏸ В ожидании',
  inbox:    '📋 Без даты',
};

// Строит и показывает сводную карточку. При reply=true отправляет новое сообщение,
// при reply=false редактирует текущее (после возврата из слайдера).
async function renderReviewSummary(ctx, userId, reply = false) {
  const data = getReviewData(userId);
  const total = data.unclosed.length + data.waiting.length + data.inbox.length;

  if (total === 0) {
    const text = '✅ Зависших задач нет. Всё под контролем!';
    return reply ? ctx.reply(text) : safeEdit(ctx, text);
  }

  // Сохраняем id задач по категориям — слайдер будет их читать
  const state = pendingTasks.get(userId) ?? {};
  state.reviewData = {
    unclosed: data.unclosed.map(t => t.id),
    waiting:  data.waiting.map(t => t.id),
    inbox:    data.inbox.map(t => t.id),
  };
  pendingTasks.set(userId, state);

  const lines = ['🔍 *Разбор задач*\n'];
  const buttons = [];

  if (data.unclosed.length) {
    lines.push(`📅 Из плана на сегодня: *${data.unclosed.length}*`);
    buttons.push([Markup.button.callback(`📅 Из плана (${data.unclosed.length})`, 'rv_open_unclosed')]);
  }
  if (data.waiting.length) {
    lines.push(`⏸ В ожидании: *${data.waiting.length}*`);
    buttons.push([Markup.button.callback(`⏸ В ожидании (${data.waiting.length})`, 'rv_open_waiting')]);
  }
  if (data.inbox.length) {
    lines.push(`📋 Без даты: *${data.inbox.length}*`);
    buttons.push([Markup.button.callback(`📋 Без даты (${data.inbox.length})`, 'rv_open_inbox')]);
  }
  if (data.doneToday > 0) {
    lines.push(`\n✅ Выполнено сегодня: *${data.doneToday}*`);
  }
  const opts = { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) };
  return reply ? ctx.reply(lines.join('\n'), opts) : safeEdit(ctx, lines.join('\n'), opts);
}

// Показывает текущую задачу в слайдере — редактирует сообщение.
async function renderReviewSlider(ctx, userId) {
  const state = pendingTasks.get(userId);
  const { taskIds, index, category } = state.reviewSlider;

  if (index >= taskIds.length) {
    return safeEdit(ctx, `✅ *${RV_LABELS[category]}* — разобрано!`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('◀️ К списку', 'rv_back')]]),
    });
  }

  const task = getTaskById(taskIds[index]);
  if (!task || task.status === 'deleted') {
    state.reviewSlider.index++;
    pendingTasks.set(userId, state);
    return renderReviewSlider(ctx, userId);
  }

  const age   = daysSince(task.updated_at);
  const ageStr  = age > 0 ? ` _(${age} дн.)_` : '';
  const counter = `_${index + 1} из ${taskIds.length}_`;
  const nav = [
    Markup.button.callback('◀️', index > 0 ? 'rv_prev' : 'rv_noop'),
    Markup.button.callback('📋 К списку', 'rv_back'),
    Markup.button.callback('▶️', 'rv_next'),
  ];

  let text, buttons;

  if (category === 'unclosed') {
    text = `📅 *${task.title}*\nБыло в плане на сегодня.\n${counter}`;
    buttons = [
      [Markup.button.callback('✅ Сделал', `rv_done_${task.id}`), Markup.button.callback('📅 На завтра', `rv_tomorrow_${task.id}`)],
      [Markup.button.callback('🗑 Удалить', `rv_del_${task.id}`)],
      nav,
    ];
  } else if (category === 'waiting' && task.waiting_until) {
    text = `⏸ *${task.title}*${ageStr}\nСрок ожидания вышел.\n${counter}`;
    buttons = [
      [Markup.button.callback('▶️ Взять в работу', `rv_todo_${task.id}`)],
      [Markup.button.callback('⏸ Ещё жду', `rv_keep_${task.id}`), Markup.button.callback('❌ Закрыть', `rv_done_${task.id}`)],
      nav,
    ];
  } else if (category === 'waiting') {
    text = `⏸ *${task.title}*${ageStr}\nПора напомнить?\n${counter}`;
    buttons = [
      [Markup.button.callback('▶️ Взять в работу', `rv_todo_${task.id}`)],
      [Markup.button.callback('⏸ Ещё жду', `rv_keep_${task.id}`), Markup.button.callback('❌ Закрыть', `rv_done_${task.id}`)],
      nav,
    ];
  } else if (category === 'inbox') {
    text = `📋 *${task.title}*${ageStr}\nЛежит без даты. Запланировать или убрать?\n${counter}`;
    buttons = [
      [Markup.button.callback('📅 На завтра', `rv_tomorrow_${task.id}`), Markup.button.callback('📅 Выбрать дату', `rv_pick_date_${task.id}`)],
      [Markup.button.callback('⏭ Отложить', `rv_snooze_${task.id}`), Markup.button.callback('🗑 Удалить', `rv_del_${task.id}`)],
      nav,
    ];
  } else {
    text = `💭 *${task.title}*${ageStr}\nВсё ещё думаешь об этом?\n${counter}`;
    buttons = [
      [Markup.button.callback('✅ Да, беру в работу', `rv_todo_${task.id}`)],
      [Markup.button.callback('🗑 Удалить', `rv_del_${task.id}`)],
      nav,
    ];
  }

  await safeEdit(ctx, text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
}

async function handleReview(ctx) {
  const userId = getUser(ctx);
  await renderReviewSummary(ctx, userId, true);
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

  // Plan — открыть слайдер категории
  bot.action(/^plan_open_(planned|suggestions)$/, async (ctx) => {
    const category = ctx.match[1];
    const userId   = getUser(ctx);
    let state = pendingTasks.get(userId) ?? {};

    // State потерян (перезапуск бота) — восстанавливаем запланированные из БД
    if (!state.planData) {
      const today = addDays(0);
      const planned = getTasksByPlannedDate(userId, today);
      state.planData = { date: today, plannedIds: planned.map(t => t.id), suggestions: [] };
      pendingTasks.set(userId, state);
    }

    const isEmpty = category === 'planned'
      ? !state.planData.plannedIds?.length
      : !state.planData.suggestions?.length;
    if (isEmpty) return ctx.answerCbQuery('Задач нет');
    state.planSlider = { category, index: 0 };
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await renderPlanSlider(ctx, userId);
  });

  // Plan — вернуться к сводке (обновляем запланированные из БД, AI-рекомендации сохраняем)
  bot.action('plan_back', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId);
    if (!state?.planData) return ctx.answerCbQuery('Сессия устарела');
    delete state.planSlider;
    const planned = getTasksByPlannedDate(userId, state.planData.date);
    state.planData.plannedIds = planned.map(t => t.id);
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await renderPlanSummary(ctx, userId);
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
  bot.action(/^plan_tomorrow_(\d+)$/, planAction((id, uid) => updateTask(id, { planned_for: addDays(1) }, uid), '📅 На завтра'));
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

  // Review — открыть слайдер категории
  bot.action(/^rv_open_(unclosed|waiting|inbox)$/, async (ctx) => {
    const category = ctx.match[1];
    const userId   = getUser(ctx);
    let state = pendingTasks.get(userId) ?? {};

    // State потерян (перезапуск бота) — перезагружаем из БД
    if (!state.reviewData) {
      const data = getReviewData(userId);
      state.reviewData = {
        unclosed: data.unclosed.map(t => t.id),
        waiting:  data.waiting.map(t => t.id),
        inbox:    data.inbox.map(t => t.id),
      };
      pendingTasks.set(userId, state);
    }

    const taskIds = state.reviewData[category] ?? [];
    if (!taskIds.length) return ctx.answerCbQuery('Задач нет');
    state.reviewSlider = { taskIds, index: 0, category };
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await renderReviewSlider(ctx, userId);
  });

  // Review — вернуться к сводке
  bot.action('rv_back', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId) ?? {};
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

  // Review — действия над задачей (применяют + переходят к следующей)
  function rvAction(fn, toast) {
    return async (ctx) => {
      const userId = getUser(ctx);
      const id     = parseInt(ctx.match[1]);
      fn(id, userId);
      await ctx.answerCbQuery(toast);
      const state = pendingTasks.get(userId);
      if (state?.reviewSlider) {
        state.reviewSlider.index++;
        pendingTasks.set(userId, state);
        await renderReviewSlider(ctx, userId);
      }
    };
  }

  bot.action(/^rv_done_(\d+)$/, async (ctx) => {
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
    if (state?.reviewSlider) {
      state.reviewSlider.index++;
      pendingTasks.set(userId, state);
      await renderReviewSlider(ctx, userId);
    }
  });
  bot.action(/^rv_todo_(\d+)$/,     rvAction((id, uid) => updateTask(id, { status: 'todo', waiting_reason: null, waiting_until: null }, uid), '▶️ Взято в работу'));
  bot.action(/^rv_snooze_(\d+)$/,  rvAction((id)      => snoozeTask(id),                                                        '⏭ Отложено на 3 дня'));
  bot.action(/^rv_del_(\d+)$/,     rvAction((id, uid) => deleteTask(id, uid),                                                   '🗑 Удалено'));
  bot.action(/^rv_keep_(\d+)$/, rvAction((id, uid) => {
    const task = getTaskById(id);
    // Если waiting_until истёк — сбрасываем его чтобы задача не появлялась каждый день
    if (task?.waiting_until) updateTask(id, { waiting_until: null }, uid);
    snoozeTask(id);
  }, '⏸ Напомню через 3 дня'));
  bot.action(/^rv_tomorrow_(\d+)$/, rvAction((id, uid) => updateTask(id, { planned_for: addDays(1) }, uid),                     '📅 На завтра'));

  // Review inbox — открыть календарь для выбора даты
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

  // Review calendar — выбор даты → поставить planned_for и перейти к следующей задаче
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
      state.reviewSlider.index++;
      pendingTasks.set(userId, state);
      await renderReviewSlider(ctx, userId);
    }
  });

  // Review calendar — закрыть, вернуться к текущей задаче в слайдере
  bot.action('rvcal_close', async (ctx) => {
    const userId = getUser(ctx);
    await ctx.answerCbQuery();
    await renderReviewSlider(ctx, userId);
  });

  // Review calendar — заглушка для пустых ячеек и заголовка
  bot.action('rvcal_noop', ctx => ctx.answerCbQuery());

}

module.exports = { register, handlePlan, handleReview };
