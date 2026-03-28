const { Markup } = require('telegraf');
const { getUser } = require('../helpers');
const {
  getMorningPlan, getReviewTasks, getProgress,
  logNotification, wasNotifiedToday, isQuietMode,
} = require('../assistantService');
const { getTaskById, updateTask, getTasks } = require('../taskService');
const { getAll: getAllRecurring, remove: removeRecurring, formatSchedule } = require('../recurringService');

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

async function handleMorning(ctx) {
  getUser(ctx);
  const userId = ctx.from.id;
  await ctx.sendChatAction('typing');

  let items;
  try {
    items = await getMorningPlan(userId);
  } catch (e) {
    console.error('[morning]', e.message);
    return ctx.reply('⚠️ Не удалось составить план. Попробуй позже.');
  }

  if (!items || !items.length) {
    return ctx.reply('✅ Активных задач нет. Отличное время добавить новые!');
  }

  const tasks = await Promise.all(
    items.map(async ({ id, reason }) => {
      const t = getTaskById(id);
      return t ? { task: t, reason } : null;
    })
  );
  const valid = tasks.filter(Boolean);

  if (!valid.length) {
    return ctx.reply('✅ Активных задач нет. Отличное время добавить новые!');
  }

  const lines = ['🌅 *Доброе утро! На сегодня:*\n'];
  valid.forEach(({ task, reason }, i) => {
    lines.push(`${i + 1}. *${task.title}*\n   → ${reason}`);
  });

  logNotification(userId, 'morning');

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Берусь', 'ast_morning_ok')],
      [Markup.button.callback('✏️ Изменить список', 'ast_morning_edit')],
    ]),
  });
}

// ─── /review ─────────────────────────────────────────────────

async function handleReview(ctx) {
  getUser(ctx);
  const userId = ctx.from.id;

  const tasks = getReviewTasks(userId);

  if (!tasks.length) {
    return ctx.reply('✅ Зависших задач нет. Всё под контролем!');
  }

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
      // Stale todo
      text = `📋 *${t.title}*${ageStr}\n_Давно не двигается. Что с этим?_`;
      buttons = [
        [Markup.button.callback('▶️ Взять в работу', `ast_rv_todo_${t.id}`)],
        [Markup.button.callback('💭 В maybe', `ast_rv_maybe_${t.id}`), Markup.button.callback('🗑 Удалить', `ast_rv_del_${t.id}`)],
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
  bot.command('morning', handleMorning);
  bot.command('review', handleReview);
  bot.command('progress', handleProgress);
  bot.command('reminders', handleReminders);

  // Morning
  bot.action('ast_morning_ok', ctx => {
    ctx.answerCbQuery();
    ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    ctx.reply('💪 Отлично! Удачного дня.');
  });
  bot.action('ast_morning_edit', ctx => {
    ctx.answerCbQuery();
    ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    ctx.reply('Напиши что добавить или убрать из плана — голосом или текстом.');
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
  bot.action(/^ast_rv_remind_(\d+)$/, ctx => {
    ctx.answerCbQuery();
    ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    ctx.reply('Напиши задачу-напоминание — добавлю.');
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
