const { Markup } = require('telegraf');
const { getUser } = require('../../../shared/helpers');
const { getMorningPlan, getReviewData, getProgress } = require('../../../application/assistant');
const { logNotification, wasNotifiedToday } = require('../../../application/notifications');
const { isQuietMode } = require('../../../application/settings');
const { getTaskById, updateTask, deleteTask, getTasks, getTasksByPlannedDate } = require('../../../application/tasks');
const { pendingTasks } = require('../../../shared/state');
const { safeEdit } = require('../../../shared/helpers');
const { getAllRecurring, removeRecurring, formatSchedule } = require('../../../application/notifications');

// ─── Helpers ──────────────────────────────────────────────────

function daysSince(dateStr) {
  if (!dateStr) return 0;
  const d = new Date(dateStr.slice(0, 10));
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function progressBar(done, total) {
  if (!total) return '░░░░░░░░';
  const filled = Math.round((done / total) * 8);
  return '█'.repeat(filled) + '░'.repeat(8 - filled);
}

// ─── /morning ────────────────────────────────────────────────

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

async function handleMorning(ctx) {
  getUser(ctx);
  const today    = addDays(0);
  const tomorrow = addDays(1);
  const d2       = addDays(2);
  const d3       = addDays(3);

  await ctx.reply('📅 *На какой день составить план?*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback(`Сегодня ${formatDateLabel(today)}`,    `mplan_${today}`),
        Markup.button.callback(`Завтра ${formatDateLabel(tomorrow)}`,  `mplan_${tomorrow}`),
      ],
      [
        Markup.button.callback(formatDateLabel(d2), `mplan_${d2}`),
        Markup.button.callback(formatDateLabel(d3), `mplan_${d3}`),
      ],
    ]),
  });
}

async function handleMorningForDate(ctx, date) {
  const userId = ctx.from.id;
  await safeEdit(ctx, `⏳ _Анализирую задачи на ${formatDateLabel(date)}..._`, { parse_mode: 'Markdown' });

  const planned = getTasksByPlannedDate(userId, date);

  let aiSuggestions = [];
  try {
    const items = await getMorningPlan(userId, date);
    aiSuggestions = items
      .map(({ id, reason }) => getTaskById(id) ? { id, reason } : null)
      .filter(Boolean);
  } catch (e) {
    console.error('[plan]', e.message);
  }

  logNotification(userId, 'morning');

  const state = pendingTasks.get(userId) ?? {};
  state.planData = {
    date,
    plannedIds:  planned.map(t => t.id),
    suggestions: aiSuggestions,
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
  } else {
    lines.push('_Ничего не запланировано._');
  }

  if (suggestions.length) {
    lines.push(`🤖 Рекомендует AI: *${suggestions.length}*`);
    buttons.push([Markup.button.callback(`🤖 Рекомендации (${suggestions.length})`, 'plan_open_suggestions')]);
  }

  await safeEdit(ctx, lines.join('\n'), {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons),
  });
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
  maybe:    '💭 Может быть',
};

// Строит и показывает сводную карточку. При reply=true отправляет новое сообщение,
// при reply=false редактирует текущее (после возврата из слайдера).
async function renderReviewSummary(ctx, userId, reply = false) {
  const data = getReviewData(userId);
  const total = data.unclosed.length + data.waiting.length + data.inbox.length + data.maybe.length;

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
    maybe:    data.maybe.map(t => t.id),
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
  if (data.maybe.length) {
    lines.push(`💭 Может быть: *${data.maybe.length}*`);
    buttons.push([Markup.button.callback(`💭 Может быть (${data.maybe.length})`, 'rv_open_maybe')]);
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
      [Markup.button.callback('📅 На завтра', `rv_tomorrow_${task.id}`), Markup.button.callback('💭 В maybe', `rv_maybe_${task.id}`)],
      [Markup.button.callback('🗑 Удалить', `rv_del_${task.id}`)],
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
  logNotification(userId, 'review');
  await renderReviewSummary(ctx, userId, true);
}

// ─── /progress ───────────────────────────────────────────────

async function handleProgress(ctx) {
  getUser(ctx);
  const userId = ctx.from.id;

  const { doneToday, doneWeek, plans, stale } = getProgress(userId);

  const lines = ['📊 *Прогресс*\n'];
  lines.push(`✅ Сегодня: ${doneToday} задач`);
  lines.push(`✅ За неделю: ${doneWeek} задач`);

  if (plans.length) {
    lines.push('');
    for (const p of plans) {
      const bar = progressBar(p.done_count ?? 0, p.total_count ?? 0);
      lines.push(`${p.title}  ${bar}  ${p.done_count ?? 0}/${p.total_count ?? 0}`);
    }
  }

  if (stale.length) {
    lines.push('');
    lines.push('⚠️ *Давно без движения:*');
    stale.forEach(t => {
      const age = daysSince(t.updated_at);
      lines.push(`• ${t.title} (${age} дн.)`);
    });
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
}

// ─── Кнопки ──────────────────────────────────────────────────

async function handleReminders(ctx) {
  getUser(ctx);
  const userId = ctx.from.id;
  const items = getAllRecurring(userId);

  if (!items.length) {
    return ctx.reply(
      'Повторяющихся напоминаний нет.\n\nДобавь голосом или текстом:\n"Каждый понедельник в 23:00 созвон, напомни за 30 минут"'
    );
  }

  const lines = ['🔄 *Повторяющиеся напоминания:*\n'];
  items.forEach((r, i) => {
    lines.push(`${i + 1}. *${r.title}*\n   ${formatSchedule(r)}`);
  });

  const buttons = items.map(r => [
    Markup.button.callback(`🗑 Удалить: ${r.title}`, `rec_del_${r.id}`),
  ]);

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons),
  });
}

function register(bot) {
  bot.command('plan', handleMorning);
  bot.command('morning', handleMorning); // backwards compat
  bot.command('review', handleReview);
  bot.command('progress', handleProgress);
  bot.command('reminders', handleReminders);

  // Morning — выбор даты
  bot.action(/^mplan_(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    const date = ctx.match[1];
    getUser(ctx);
    await ctx.answerCbQuery();
    await handleMorningForDate(ctx, date);
  });

  // Plan — открыть слайдер категории
  bot.action(/^plan_open_(planned|suggestions)$/, async (ctx) => {
    const category = ctx.match[1];
    const userId   = getUser(ctx);
    const state    = pendingTasks.get(userId) ?? {};
    const isEmpty  = category === 'planned'
      ? !state.planData?.plannedIds?.length
      : !state.planData?.suggestions?.length;
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

  bot.action(/^plan_done_(\d+)$/,    planAction((id, uid) => updateTask(id, { status: 'done' }, uid),       '✅ Готово'));
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
  bot.action(/^rv_open_(unclosed|waiting|inbox|maybe)$/, async (ctx) => {
    const category = ctx.match[1];
    const userId   = getUser(ctx);
    const state    = pendingTasks.get(userId) ?? {};
    const taskIds  = state.reviewData?.[category] ?? [];
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

  bot.action(/^rv_done_(\d+)$/,     rvAction((id, uid) => updateTask(id, { status: 'done' }, uid),                               '✅ Готово'));
  bot.action(/^rv_todo_(\d+)$/,     rvAction((id, uid) => updateTask(id, { status: 'todo', waiting_reason: null, waiting_until: null }, uid), '▶️ Взято в работу'));
  bot.action(/^rv_maybe_(\d+)$/,    rvAction((id, uid) => updateTask(id, { status: 'maybe' }, uid),                              '💭 В может быть'));
  bot.action(/^rv_del_(\d+)$/,      rvAction((id, uid) => deleteTask(id, uid),                                                   '🗑 Удалено'));
  bot.action(/^rv_keep_(\d+)$/,     rvAction(() => {},                                                                           '⏸ Оставлено'));
  bot.action(/^rv_tomorrow_(\d+)$/, rvAction((id, uid) => updateTask(id, { planned_for: addDays(1) }, uid),                      '📅 На завтра'));

  // Recurring — удаление
  bot.action(/^rec_del_(\d+)$/, ctx => {
    const id = parseInt(ctx.match[1]);
    removeRecurring(id);
    ctx.answerCbQuery('Удалено');
    ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    ctx.reply('🗑 Напоминание удалено.');
  });
}

module.exports = { register, handleMorning, handleReview };
