const { Markup } = require('telegraf');
const { getUser } = require('../../../shared/helpers');
const { getMorningPlan, getReviewTasks, getUnclosedPlannedTasks, getProgress } = require('../../../application/assistant');
const { logNotification, wasNotifiedToday } = require('../../../application/notifications');
const { isQuietMode } = require('../../../application/settings');
const { getTaskById, updateTask, getTasks, getTasksByPlannedDate } = require('../../../application/tasks');
const { getAll: getAllRecurring, remove: removeRecurring, formatSchedule } = require('../../../application/notifications');

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
  await ctx.sendChatAction('typing');

  const planned = getTasksByPlannedDate(userId, date);

  let suggestions = [];
  try {
    const items = await getMorningPlan(userId, date);
    suggestions = items
      .map(({ id, reason }) => {
        const t = getTaskById(id);
        return t ? { task: t, reason } : null;
      })
      .filter(Boolean);
  } catch (e) {
    console.error('[morning]', e.message);
  }

  const dateLabel = formatDateLabel(date);
  const lines = [`📅 *План на ${dateLabel}*\n`];

  if (planned.length) {
    lines.push('*Запланировано:*');
    planned.forEach((t, i) => {
      lines.push(`${i + 1}. ${t.status === 'done' ? '✅' : '☐'} ${t.title}`);
    });
  } else {
    lines.push('_Пока ничего не запланировано._');
  }

  if (suggestions.length) {
    lines.push('\n*AI предлагает добавить:*');
    suggestions.forEach(({ task, reason }, i) => {
      lines.push(`${planned.length + i + 1}. *${task.title}*\n   → ${reason}`);
    });
  }

  logNotification(userId, 'morning');

  const addButtons = suggestions.map(({ task }) =>
    [Markup.button.callback(`➕ ${task.title}`, `mplan_add_${date}_${task.id}`)]
  );

  await ctx.editMessageText(lines.join('\n'), {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      ...addButtons,
      [Markup.button.callback('✅ Сохранить план', `mplan_save_${date}`)],
    ]),
  });
}

// ─── /review ─────────────────────────────────────────────────

async function handleReview(ctx) {
  getUser(ctx);
  const userId = ctx.from.id;

  // Незакрытые задачи из плана на сегодня — одним блоком
  const unclosed = getUnclosedPlannedTasks(userId);
  if (unclosed.length) {
    const titles = unclosed.map(t => `• ${t.title}`).join('\n');
    const ids = unclosed.map(t => t.id).join('_');
    await ctx.reply(
      `📅 *Не закрыто из плана на сегодня (${unclosed.length}):*\n${titles}\n\n_Перенести на завтра?_`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('▶️ Перенести все на завтра', `ast_rv_tomorrow_bulk_${ids}`)],
          [Markup.button.callback('⏭ Пропустить', 'ast_rv_skip')],
        ]),
      }
    );
  }

  const tasks = getReviewTasks(userId);

  if (!tasks.length && !unclosed.length) {
    return ctx.reply('✅ Зависших задач нет. Всё под контролем!');
  }

  if (!tasks.length) return;

  logNotification(userId, 'review');

  for (const t of tasks) {
    const age = daysSince(t.updated_at);
    const ageStr = age > 0 ? ` (${age} дн.)` : '';

    let text, buttons;

    if (t.status === 'waiting' && t.waiting_until) {
      // Просроченное waiting
      text = `⏸ *${t.title}*${ageStr}\n_Срок ожидания вышел. Что делаем?_`;
      buttons = [
        [Markup.button.callback('▶️ Взять в работу', `ast_rv_todo_${t.id}`)],
        [Markup.button.callback('⏸ Ещё жду', `ast_rv_keep_${t.id}`), Markup.button.callback('❌ Закрыть', `ast_rv_done_${t.id}`)],
      ];
    } else if (t.status === 'waiting') {
      // Waiting без даты
      text = `⏸ *${t.title}*${ageStr}\n_Пора напомнить?_`;
      buttons = [
        [Markup.button.callback('📋 Добавить задачу', `ast_rv_remind_${t.id}`)],
        [Markup.button.callback('⏸ Ещё жду', `ast_rv_keep_${t.id}`), Markup.button.callback('❌ Закрыть', `ast_rv_done_${t.id}`)],
      ];
    } else if (t.status === 'maybe') {
      text = `💭 *${t.title}*${ageStr}\n_Всё ещё думаешь об этом?_`;
      buttons = [
        [Markup.button.callback('✅ Да, беру в работу', `ast_rv_todo_${t.id}`)],
        [Markup.button.callback('🗑 Удалить', `ast_rv_del_${t.id}`)],
      ];
    } else {
      // Inbox: todo без даты
      text = `📋 *${t.title}*${ageStr}\n_Лежит без даты. Запланировать или убрать?_`;
      buttons = [
        [Markup.button.callback('📅 На завтра', `ast_rv_tomorrow_${t.id}`), Markup.button.callback('💭 В maybe', `ast_rv_maybe_${t.id}`)],
        [Markup.button.callback('🗑 Удалить', `ast_rv_del_${t.id}`)],
      ];
    }

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  }

  await ctx.reply('_Это все зависшие задачи._', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⏭ Пропустить всё', 'ast_rv_skip')]]),
  });
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

  // Morning — добавить задачу в план на дату
  bot.action(/^mplan_add_(\d{4}-\d{2}-\d{2})_(\d+)$/, async (ctx) => {
    const date   = ctx.match[1];
    const taskId = parseInt(ctx.match[2]);
    getUser(ctx);
    await ctx.answerCbQuery('Добавлено в план');
    updateTask(taskId, { planned_for: date });
    await handleMorningForDate(ctx, date);
  });

  // Morning — сохранить план
  bot.action(/^mplan_save_(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    const date = ctx.match[1];
    await ctx.answerCbQuery('План сохранён ✅');
    ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    ctx.reply(`💪 План на ${formatDateLabel(date)} сохранён. Удачного дня!`);
  });

  // Review actions
  bot.action(/^ast_rv_todo_(\d+)$/, ctx => {
    const id = parseInt(ctx.match[1]);
    updateTask(id, { status: 'todo', waiting_reason: null, waiting_until: null });
    ctx.answerCbQuery('Взято в работу');
    ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  });
  bot.action(/^ast_rv_keep_(\d+)$/, ctx => {
    ctx.answerCbQuery('Хорошо, оставлю');
    ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  });
  bot.action(/^ast_rv_done_(\d+)$/, ctx => {
    const id = parseInt(ctx.match[1]);
    updateTask(id, { status: 'done' });
    ctx.answerCbQuery('Закрыто ✅');
    ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  });
  bot.action(/^ast_rv_del_(\d+)$/, ctx => {
    const id = parseInt(ctx.match[1]);
    updateTask(id, { status: 'deleted' });
    ctx.answerCbQuery('Удалено');
    ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  });
  bot.action(/^ast_rv_maybe_(\d+)$/, ctx => {
    const id = parseInt(ctx.match[1]);
    updateTask(id, { status: 'maybe' });
    ctx.answerCbQuery('Перенесено в «Возможно»');
    ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  });
  bot.action(/^ast_rv_tomorrow_(\d+)$/, ctx => {
    const id = parseInt(ctx.match[1]);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    updateTask(id, { planned_for: tomorrow.toISOString().split('T')[0] });
    ctx.answerCbQuery('Перенесено на завтра');
    ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  });
  bot.action(/^ast_rv_remind_(\d+)$/, ctx => {
    ctx.answerCbQuery();
    ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    ctx.reply('Напиши задачу-напоминание — добавлю.');
  });
  // Перенести все незакрытые задачи из плана на завтра одним нажатием
  bot.action(/^ast_rv_tomorrow_bulk_(.+)$/, ctx => {
    const ids = ctx.match[1].split('_').map(Number);
    const tomorrow = addDays(1);
    ids.forEach(id => updateTask(id, { planned_for: tomorrow }));
    ctx.answerCbQuery(`Перенесено на завтра: ${ids.length}`);
    ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  });
  bot.action('ast_rv_skip', ctx => {
    ctx.answerCbQuery('Пропущено');
    ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  });

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
