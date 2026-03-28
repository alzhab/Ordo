const { Markup } = require('telegraf');
const { getUser, safeEdit, safeDelete, normalizeWaiting, extractNotionPageId, parseReminderDatetime } = require('../helpers');
const { pendingTasks, taskFilters, getFilter, taskPlanContext, acquireProcessing, releaseProcessing } = require('../state');
const { formatTaskDetail, formatPreview } = require('../formatters');
const {
  taskDetailButtons, buildCategoryButtons, confirmButtons,
} = require('../keyboards');
const { renderTaskListFiltered } = require('../renderers');
const {
  getTasks, getTasksByPlannedDate, getTaskById, updateTask, deleteTask, getUnsyncedTasks,
} = require('../taskService');
const { getGoalsWithProgress, getGoalById } = require('../goalService');
const { getCategoryNames, getCategoryByName, createCategory } = require('../categoryService');
const {
  getSubtasks, createSubtasks, updateSubtask,
} = require('../subtaskService');
const { syncSubtasksToNotion } = require('../integrations/notion');
const {
  isConfigured: notionConfigured,
  pushTask, updateTaskFields, updateTaskStatus,
} = require('../integrations/notion');
const { logSyncError } = require('../syncErrorService');
const { getNotionEnabled } = require('../assistantService');

function notionEnabled(userId) { return notionConfigured() && getNotionEnabled(userId); }

const STATUS_LABEL = { not_started: '⬜ Возвращено', in_progress: '🔄 В работу', done: '✅ Готово!' };

const needsNotionLink = (task, userId) => notionEnabled(userId) && !task.notion_page_id;

async function finishWaiting(ctx, userId, state, waitingUntil) {
  const { taskId, waiting_reason: rawReason } = state.settingWaiting;
  delete state.settingWaiting;
  pendingTasks.set(userId, state);
  const { waiting_reason, waiting_until } = normalizeWaiting(rawReason, waitingUntil);
  const updated = updateTask(taskId, {
    status: 'waiting',
    waiting_reason,
    waiting_until,
  });
  if (notionEnabled(userId) && updated.notion_page_id) {
    updateTaskStatus(updated.notion_page_id, 'waiting').catch(() => {});
    updateTaskFields(updated.notion_page_id, updated).catch(() => {});
  }
  const planId = taskPlanContext.get(userId) ?? null;
  const detail = formatTaskDetail(updated);
  const opts   = { parse_mode: 'Markdown', ...taskDetailButtons(updated, planId, needsNotionLink(updated, userId)) };
  // safeEdit работает только в callback-контексте; при текстовом вводе используем reply
  if (ctx.callbackQuery) {
    await safeEdit(ctx, detail, opts);
  } else {
    await ctx.reply(detail, opts);
  }
}

async function showNextBatchTask(ctx, userId, state, edit = true) {
  const { batchTasks, batchIndex, batchCreated } = state;
  if (batchIndex >= batchTasks.length) {
    pendingTasks.delete(userId);
    const count   = batchCreated.length;
    const skipped = batchTasks.length - count;
    let text = `✅ Создано *${count}* задач${skipped > 0 ? ` (пропущено: ${skipped})` : ''}`;
    const rows = batchCreated.map(t => [Markup.button.callback(`📋 ${t.title}`, `tv_${t.id}`)]);
    const opts = { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) };
    return edit ? safeEdit(ctx, text, opts) : ctx.reply(text, opts);
  }
  const task    = batchTasks[batchIndex];
  const { formatBatchTaskPreview } = require('../formatters');
  const text    = formatBatchTaskPreview(task, batchIndex, batchTasks.length);
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Создать', 'batch_do'), Markup.button.callback('⏭ Пропустить', 'batch_skip')],
    [Markup.button.callback('❌ Отмена', 'cancel')],
  ]);
  const opts = { parse_mode: 'Markdown', ...keyboard };
  return edit ? safeEdit(ctx, text, opts) : ctx.reply(text, opts);
}

function register(bot) {
  // /tasks
  bot.command('tasks', (ctx) => {
    const userId = getUser(ctx);
    renderTaskListFiltered(ctx, userId, getFilter(userId));
  });


  // Просмотр задачи
  bot.action(/^tv_(\d+)$/, async (ctx) => {
    const taskId = Number(ctx.match[1]);
    const userId = getUser(ctx);
    const task   = getTaskById(taskId);
    await ctx.answerCbQuery();
    if (!task) return ctx.reply('Задача не найдена.');
    await safeDelete(ctx);
    await ctx.reply(formatTaskDetail(task), { parse_mode: 'Markdown', ...taskDetailButtons(task, null, needsNotionLink(task, userId)) });
  });

  // Просмотр задачи из контекста цели
  bot.action(/^tvg_(\d+)_(\d+)$/, async (ctx) => {
    const goalId = Number(ctx.match[1]);
    const taskId = Number(ctx.match[2]);
    const userId = getUser(ctx);
    const task   = getTaskById(taskId);
    await ctx.answerCbQuery();
    if (!task) return ctx.reply('Задача не найдена.');
    taskPlanContext.set(userId, goalId);
    await safeDelete(ctx);
    await ctx.reply(formatTaskDetail(task), { parse_mode: 'Markdown', ...taskDetailButtons(task, goalId, needsNotionLink(task, userId)) });
  });

  // Смена статуса
  bot.action(/^ts_(not_started|in_progress|done)_(\d+)$/, async (ctx) => {
    const status  = ctx.match[1];
    const taskId  = Number(ctx.match[2]);
    const userId  = getUser(ctx);
    const fields  = { status };
    // При выходе из waiting — очищаем waiting поля
    const prev = getTaskById(taskId);
    if (prev?.status === 'waiting') {
      fields.waiting_reason = null;
      fields.waiting_until  = null;
    }
    const updated = updateTask(taskId, fields);
    await ctx.answerCbQuery(STATUS_LABEL[status]);
    if (notionEnabled(userId) && updated.notion_page_id) {
      updateTaskStatus(updated.notion_page_id, status).catch(e => { console.error('Notion status sync error:', e.message); logSyncError(userId, `Статус "${updated.title}": ${e.message}`); });
      if (prev?.status === 'waiting') {
        updateTaskFields(updated.notion_page_id, updated).catch(() => {});
      }
    }
    const planId = taskPlanContext.get(userId) ?? null;
    await safeEdit(ctx, formatTaskDetail(updated), { parse_mode: 'Markdown', ...taskDetailButtons(updated, planId, needsNotionLink(updated, userId)) });
  });

  // Перевод задачи в ожидание — шаг 1: причина
  bot.action(/^ts_waiting_(\d+)$/, async (ctx) => {
    const taskId = Number(ctx.match[1]);
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId) ?? {};
    state.settingWaiting = { taskId, step: 'reason' };
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await safeEdit(ctx, '⏸ *В ожидании*\n\nЧего ждёшь? Опиши причину:', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('Пропустить', `tw_skip_${taskId}`)]]),
    });
  });

  // Пропустить шаг в диалоге ожидания
  bot.action(/^tw_skip_(\d+)$/, async (ctx) => {
    const taskId = Number(ctx.match[1]);
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId) ?? {};
    const sw     = state.settingWaiting;
    if (!sw || sw.taskId !== taskId) return ctx.answerCbQuery('Сессия устарела.');
    await ctx.answerCbQuery();
    if (sw.step === 'reason') {
      sw.waiting_reason = null;
      sw.step = 'until';
      pendingTasks.set(userId, state);
      await safeEdit(ctx, '⏸ *В ожидании*\n\nДо какой даты ждёшь? (например: "25 марта", "через неделю")', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('Пропустить', `tw_skip_${taskId}`)]]),
      });
    } else {
      await finishWaiting(ctx, userId, state, null);
    }
  });

  // Удаление задачи
  bot.action(/^ts_delete_(\d+)$/, async (ctx) => {
    const taskId = Number(ctx.match[1]);
    await ctx.answerCbQuery();
    await ctx.reply('🗑 Удалить задачу?', Markup.inlineKeyboard([
      Markup.button.callback('Да, удалить', `ts_confirm_delete_${taskId}`),
      Markup.button.callback('Отмена', 'ts_cancel_delete'),
    ]));
  });

  // Быстрая отметка выполнено из напоминания
  bot.action(/^ts_done_(\d+)$/, async (ctx) => {
    const taskId = Number(ctx.match[1]);
    const userId = getUser(ctx);
    const updated = updateTask(taskId, { status: 'done' });
    if (notionEnabled(userId) && updated.notion_page_id) {
      updateTaskStatus(updated.notion_page_id, 'done').catch(() => {});
    }
    await ctx.answerCbQuery('✅ Готово!');
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  });

  bot.action(/^ts_confirm_delete_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const taskId = Number(ctx.match[1]);
    const task   = getTaskById(taskId);
    deleteTask(taskId);
    if (notionEnabled(userId) && task?.notion_page_id) {
      updateTaskStatus(task.notion_page_id, 'deleted').catch(() => {});
    }
    await ctx.answerCbQuery('🗑 Удалено');
    await safeDelete(ctx);
    renderTaskListFiltered(ctx, userId, getFilter(userId));
  });

  bot.action('ts_cancel_delete', async (ctx) => {
    await ctx.answerCbQuery();
    await safeDelete(ctx);
  });

  // Назад к списку
  bot.action('back_to_tasks', async (ctx) => {
    const userId = getUser(ctx);
    taskPlanContext.delete(userId);
    await ctx.answerCbQuery();
    await safeDelete(ctx);
    renderTaskListFiltered(ctx, userId, getFilter(userId));
  });

  // Привязать задачу к существующей Notion странице
  bot.action(/^notion_link_(\d+)$/, async (ctx) => {
    const taskId = Number(ctx.match[1]);
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId) ?? {};
    state.linkingNotion = { taskId };
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await safeEdit(ctx, '🔗 *Привязать к Notion*\n\nОтправь URL страницы Notion или её ID:', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', `tv_${taskId}`)]]),
    });
  });

  // Подтверждение создания задачи
  bot.action('confirm', async (ctx) => {
    const userId = getUser(ctx);
    if (!acquireProcessing(userId)) return ctx.answerCbQuery('⏳ Уже обрабатывается...');
    const state  = pendingTasks.get(userId);
    if (!state) { releaseProcessing(userId); return ctx.answerCbQuery('Сессия устарела, отправь задачу заново.'); }
    const parsed = state.task;

    await ctx.answerCbQuery();
    await safeEdit(ctx, '⏳ Сохраняю задачу...');

    try {
      const { createTask } = require('../taskService');
      // Нормализуем waiting поля: если дата спрятана в причине — вытащить
      if (parsed.status === 'waiting') {
        const { normalizeWaiting } = require('../helpers');
        const norm = normalizeWaiting(parsed.waiting_reason, parsed.waiting_until);
        parsed.waiting_reason = norm.waiting_reason;
        parsed.waiting_until  = norm.waiting_until;
      }
      const saved = createTask(userId, parsed);

      if (parsed.subtasks?.length) {
        createSubtasks(saved.id, parsed.subtasks);
      }
      pendingTasks.delete(userId);

      if (notionEnabled(userId)) {
        pushTask(saved)
          .then(async notionPageId => {
            await updateTask(saved.id, { notion_page_id: notionPageId });
            if (saved.status === 'waiting') {
              updateTaskStatus(notionPageId, 'waiting').catch(() => {});
            }
            if (parsed.subtasks?.length) {
              const subtasks = getSubtasks(saved.id);
              const mapping  = await syncSubtasksToNotion(notionPageId, subtasks);
              mapping.forEach(({ subtaskId, blockId }) => updateSubtask(subtaskId, { notion_block_id: blockId }));
            }
          })
          .catch(e => { console.error('Notion sync error:', e.message); logSyncError(userId, `Создание задачи "${saved.title}": ${e.message}`); });
      }

      const hasSubtasks = parsed.subtasks?.length > 0;
      const buttons = hasSubtasks
        ? [[Markup.button.callback('📋 Открыть задачу', `tv_${saved.id}`)]]
        : [
            [Markup.button.callback('🤖 Предложить шаги', `ai_steps_${saved.id}`)],
            [Markup.button.callback('📋 Открыть задачу', `tv_${saved.id}`)],
          ];

      await safeEdit(ctx, `✅ Задача *${saved.title}* создана!`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons),
      });
    } catch (e) {
      console.error(e);
      await safeEdit(ctx, '❌ Ошибка при создании задачи.');
    } finally {
      releaseProcessing(userId);
    }
  });

  // Отмена
  bot.action('cancel', async (ctx) => {
    const userId = getUser(ctx);
    pendingTasks.delete(userId);
    await ctx.answerCbQuery();
    await safeEdit(ctx, '❌ Отменено.');
  });

  // Выбор категории (новая задача)
  bot.action(/^cat_(.+)$/, async (ctx) => {
    const userId   = getUser(ctx);
    const category = ctx.match[1];
    const state    = pendingTasks.get(userId);
    if (!state) return ctx.answerCbQuery('Сессия устарела, отправь задачу заново.');
    state.task.category = category;
    state.editingField  = null;
    await safeEdit(ctx, formatPreview(state.task), { parse_mode: 'Markdown', ...confirmButtons });
    ctx.answerCbQuery();
  });

  // Выбор приоритета (новая задача)
  bot.action(/^pri_(.+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId);
    if (!state) return ctx.answerCbQuery('Сессия устарела, отправь задачу заново.');
    state.task.priority = ctx.match[1];
    state.editingField  = null;
    await safeEdit(ctx, formatPreview(state.task), { parse_mode: 'Markdown', ...confirmButtons });
    ctx.answerCbQuery();
  });

  // Меню редактирования (новая задача)
  bot.action('edit_menu', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId);
    if (!state) return ctx.answerCbQuery('Сессия устарела.');
    await ctx.answerCbQuery();
    await safeEdit(ctx, '✏️ *Что изменить?*', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('Название', 'edit_field_title'), Markup.button.callback('Описание', 'edit_field_description')],
        [Markup.button.callback('Категория', 'edit_field_category'), Markup.button.callback('Приоритет', 'edit_field_priority')],
        [Markup.button.callback('Дата', 'edit_field_plannedFor'), Markup.button.callback('План', 'edit_field_plan')],
        [Markup.button.callback('◀️ Назад', 'edit_back')],
      ]),
    });
  });

  bot.action('edit_back', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId);
    if (!state) return ctx.answerCbQuery('Сессия устарела.');
    state.editingField = null;
    await ctx.answerCbQuery();
    await safeEdit(ctx, formatPreview(state.task), { parse_mode: 'Markdown', ...confirmButtons });
  });

  bot.action('edit_field_category', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId);
    if (!state) return ctx.answerCbQuery('Сессия устарела.');
    await ctx.answerCbQuery();
    const categories = getCategoryNames(userId);
    await safeEdit(ctx, '📁 Выбери категорию:', buildCategoryButtons(categories, true));
  });

  bot.action('edit_field_priority', async (ctx) => {
    const state = pendingTasks.get(getUser(ctx));
    if (!state) return ctx.answerCbQuery('Сессия устарела.');
    await ctx.answerCbQuery();
    await safeEdit(ctx, '⚡ Выбери приоритет:', Markup.inlineKeyboard([
      [
        Markup.button.callback('🔴 Высокий', 'pri_Высокий'),
        Markup.button.callback('🟡 Средний', 'pri_Средний'),
        Markup.button.callback('🟢 Низкий',  'pri_Низкий'),
      ],
      [Markup.button.callback('◀️ Назад', 'edit_back')],
    ]));
  });

  bot.action('edit_field_plan', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId);
    if (!state) return ctx.answerCbQuery('Сессия устарела.');
    const goals = getGoalsWithProgress(userId);
    const rows  = goals.map(g => [Markup.button.callback(g.title, `planpick_${g.id}`)]);
    rows.push([Markup.button.callback('❌ Без цели', 'planpick_0')]);
    rows.push([Markup.button.callback('◀️ Назад', 'edit_back')]);
    await ctx.answerCbQuery();
    await safeEdit(ctx, '📎 Выбери цель:', Markup.inlineKeyboard(rows));
  });

  bot.action(/^planpick_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId);
    if (!state) return ctx.answerCbQuery('Сессия устарела.');
    const goalId = Number(ctx.match[1]);
    state.task.plan = goalId === 0 ? null : (getGoalById(goalId)?.title ?? null);
    state.editingField = null;
    await safeEdit(ctx, formatPreview(state.task), { parse_mode: 'Markdown', ...confirmButtons });
    ctx.answerCbQuery();
  });

  bot.action(/^edit_field_(title|plannedFor|description)$/, async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId);
    if (!state) return ctx.answerCbQuery('Сессия устарела.');
    const field  = ctx.match[1];
    state.editingField = field;
    await ctx.answerCbQuery();
    const labels      = { title: 'Название', plannedFor: 'Дата (ГГГГ-ММ-ДД)', description: 'Описание' };
    const current     = state.task[field];
    const currentLine = current ? `\nТекущее: \`${current}\`` : '';
    await safeEdit(ctx, `✏️ *${labels[field]}*${currentLine}\n\nОтправь новое значение текстом или голосом 🎙`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', 'edit_back')]]),
    });
  });

  // Редактирование сохранённой задачи
  bot.action(/^edit_saved_(\d+)$/, async (ctx) => {
    const taskId = Number(ctx.match[1]);
    const task   = getTaskById(taskId);
    await ctx.answerCbQuery();
    const rows = [
      [Markup.button.callback('Название', `esf_title_${taskId}`), Markup.button.callback('Описание', `esf_desc_${taskId}`)],
      [Markup.button.callback('Категория', `esf_cat_${taskId}`), Markup.button.callback('Приоритет', `esf_pri_${taskId}`)],
      [Markup.button.callback('Запланировать на', `esf_date_${taskId}`), Markup.button.callback('План', `esf_plan_${taskId}`)],
      [Markup.button.callback('🔔 Напоминание', `esf_reminder_${taskId}`)],
    ];
    if (task?.status === 'waiting') {
      rows.push([
        Markup.button.callback('⏸ Причина', `esf_wreason_${taskId}`),
        Markup.button.callback('⏸ Дата ожидания', `esf_wuntil_${taskId}`),
      ]);
    }
    rows.push([Markup.button.callback('◀️ Назад', `esf_back_${taskId}`)]);
    await safeEdit(ctx, '✏️ *Что изменить?*', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(rows),
    });
  });

  bot.action(/^esf_back_(\d+)$/, async (ctx) => {
    const taskId = Number(ctx.match[1]);
    const userId = getUser(ctx);
    const task   = getTaskById(taskId);
    await ctx.answerCbQuery();
    const planId = taskPlanContext.get(userId) ?? null;
    await safeEdit(ctx, formatTaskDetail(task), { parse_mode: 'Markdown', ...taskDetailButtons(task, planId, needsNotionLink(task, userId)) });
  });

  bot.action(/^esf_(title|desc|date)_(\d+)$/, async (ctx) => {
    const fieldKey = ctx.match[1];
    const taskId   = Number(ctx.match[2]);
    const userId   = getUser(ctx);
    const task     = getTaskById(taskId);
    const fieldMap = { title: 'title', desc: 'description', date: 'planned_for' };
    const labelMap = { title: 'Название', desc: 'Описание', date: 'Дата (ГГГГ-ММ-ДД)' };
    const field    = fieldMap[fieldKey];
    const state    = pendingTasks.get(userId) ?? {};
    state.editingSavedTask = { id: taskId, field };
    pendingTasks.set(userId, state);
    const current     = task[field];
    const currentLine = current ? `\nТекущее: \`${current}\`` : '';
    await ctx.answerCbQuery();
    await safeEdit(ctx, `✏️ *${labelMap[fieldKey]}*${currentLine}\n\nОтправь новое значение текстом или голосом 🎙`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', `edit_saved_${taskId}`)]]),
    });
  });

  // Редактирование причины и даты ожидания
  bot.action(/^esf_wreason_(\d+)$/, async (ctx) => {
    const taskId = Number(ctx.match[1]);
    const userId = getUser(ctx);
    const task   = getTaskById(taskId);
    const state  = pendingTasks.get(userId) ?? {};
    state.editingSavedTask = { id: taskId, field: 'waiting_reason' };
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    const current = task.waiting_reason;
    const currentLine = current ? `\nТекущее: _${current}_` : '';
    await safeEdit(ctx, `⏸ *Причина ожидания*${currentLine}\n\nОтправь новое значение текстом или голосом 🎙`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', `edit_saved_${taskId}`)]]),
    });
  });

  bot.action(/^esf_wuntil_(\d+)$/, async (ctx) => {
    const taskId = Number(ctx.match[1]);
    const userId = getUser(ctx);
    const task   = getTaskById(taskId);
    const state  = pendingTasks.get(userId) ?? {};
    state.editingSavedTask = { id: taskId, field: 'waiting_until' };
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    const current = task.waiting_until;
    const currentLine = current ? `\nТекущее: \`${current}\`` : '';
    await safeEdit(ctx, `⏸ *Дата ожидания*${currentLine}\n\nОтправь дату (например: "25 марта", "через неделю") или голосом 🎙`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', `edit_saved_${taskId}`)]]),
    });
  });

  bot.action(/^esf_reminder_(\d+)$/, async (ctx) => {
    const taskId = Number(ctx.match[1]);
    const userId = getUser(ctx);
    const task   = getTaskById(taskId);
    const state  = pendingTasks.get(userId) ?? {};
    state.editingSavedTask = { id: taskId, field: 'reminder_at' };
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    const current = task.reminder_at;
    const currentLine = current ? `\nТекущее: \`${current.slice(0, 16)}\`` : '';
    await safeEdit(ctx, `🔔 *Напоминание*${currentLine}\n\nКогда напомнить? Примеры:\n"завтра в 10:00", "29 марта 14:30", "через 2 часа"`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('❌ Убрать напоминание', `esf_reminder_clear_${taskId}`)],
        [Markup.button.callback('◀️ Назад', `edit_saved_${taskId}`)],
      ]),
    });
  });

  bot.action(/^esf_reminder_clear_(\d+)$/, async (ctx) => {
    const taskId = Number(ctx.match[1]);
    const userId = getUser(ctx);
    updateTask(taskId, { reminder_at: null, reminder_sent: 0 });
    await ctx.answerCbQuery('🔔 Напоминание убрано');
    const task   = getTaskById(taskId);
    const planId = taskPlanContext.get(userId) ?? null;
    await safeEdit(ctx, formatTaskDetail(task), { parse_mode: 'Markdown', ...taskDetailButtons(task, planId, needsNotionLink(task, userId)) });
  });

  bot.action(/^esf_cat_(\d+)$/, async (ctx) => {
    const taskId     = Number(ctx.match[1]);
    const userId     = getUser(ctx);
    const categories = getCategoryNames(userId);
    const rows = [];
    for (let i = 0; i < categories.length; i += 3) {
      rows.push(categories.slice(i, i + 3).map(c => Markup.button.callback(c, `catsaved_${taskId}_${c}`)));
    }
    rows.push([Markup.button.callback('◀️ Назад', `edit_saved_${taskId}`)]);
    await ctx.answerCbQuery();
    await safeEdit(ctx, '📁 Выбери категорию:', Markup.inlineKeyboard(rows));
  });

  bot.action(/^catsaved_(\d+)_(.+)$/, async (ctx) => {
    const taskId  = Number(ctx.match[1]);
    const catName = ctx.match[2];
    const userId  = getUser(ctx);
    let cat = getCategoryByName(userId, catName);
    if (!cat) cat = createCategory(userId, catName);
    const updated = updateTask(taskId, { category_id: cat.id });
    if (notionEnabled(userId) && updated.notion_page_id) {
      updateTaskFields(updated.notion_page_id, updated).catch(e => { console.error('Notion sync error:', e.message); logSyncError(userId, `Категория "${updated.title}": ${e.message}`); });
    }
    await ctx.answerCbQuery('✅ Категория обновлена');
    const planId = taskPlanContext.get(userId) ?? null;
    await safeEdit(ctx, formatTaskDetail(updated), { parse_mode: 'Markdown', ...taskDetailButtons(updated, planId, needsNotionLink(updated, userId)) });
  });

  bot.action(/^esf_pri_(\d+)$/, async (ctx) => {
    const taskId = Number(ctx.match[1]);
    await ctx.answerCbQuery();
    await safeEdit(ctx, '⚡ Выбери приоритет:', Markup.inlineKeyboard([
      [
        Markup.button.callback('🔴 Высокий', `prisaved_${taskId}_high`),
        Markup.button.callback('🟡 Средний', `prisaved_${taskId}_medium`),
        Markup.button.callback('🟢 Низкий',  `prisaved_${taskId}_low`),
      ],
      [Markup.button.callback('◀️ Назад', `edit_saved_${taskId}`)],
    ]));
  });

  bot.action(/^prisaved_(\d+)_(high|medium|low)$/, async (ctx) => {
    const taskId   = Number(ctx.match[1]);
    const priority = ctx.match[2];
    const userId   = getUser(ctx);
    const updated  = updateTask(taskId, { priority });
    if (notionEnabled(userId) && updated.notion_page_id) {
      updateTaskFields(updated.notion_page_id, updated).catch(e => { console.error('Notion sync error:', e.message); logSyncError(userId, `Приоритет "${updated.title}": ${e.message}`); });
    }
    await ctx.answerCbQuery('✅ Приоритет обновлён');
    const planId = taskPlanContext.get(userId) ?? null;
    await safeEdit(ctx, formatTaskDetail(updated), { parse_mode: 'Markdown', ...taskDetailButtons(updated, planId, needsNotionLink(updated, userId)) });
  });

  bot.action(/^esf_plan_(\d+)$/, async (ctx) => {
    const taskId = Number(ctx.match[1]);
    const userId = getUser(ctx);
    const goals  = getGoalsWithProgress(userId);
    const rows   = goals.map(g => [Markup.button.callback(g.title, `plansaved_${taskId}_${g.id}`)]);
    rows.push([Markup.button.callback('❌ Убрать из цели', `plansaved_${taskId}_0`)]);
    rows.push([Markup.button.callback('◀️ Назад', `edit_saved_${taskId}`)]);
    await ctx.answerCbQuery();
    await safeEdit(ctx, '📎 Выбери цель:', Markup.inlineKeyboard(rows));
  });

  bot.action(/^plansaved_(\d+)_(\d+)$/, async (ctx) => {
    const taskId = Number(ctx.match[1]);
    const newPlanId = Number(ctx.match[2]);
    const userId = getUser(ctx);
    const updated = updateTask(taskId, { goal_id: newPlanId === 0 ? null : newPlanId });
    if (notionEnabled(userId) && updated.notion_page_id) {
      updateTaskFields(updated.notion_page_id, updated).catch(e => { console.error('Notion sync error:', e.message); logSyncError(userId, `Цель "${updated.title}": ${e.message}`); });
    }
    await ctx.answerCbQuery('✅ Цель обновлена');
    const planId = taskPlanContext.get(userId) ?? null;
    await safeEdit(ctx, formatTaskDetail(updated), { parse_mode: 'Markdown', ...taskDetailButtons(updated, planId, needsNotionLink(updated, userId)) });
  });

  // Уточнение голосовой команды — выбор задачи
  bot.action(/^va_task_(\d+)$/, async (ctx) => {
    const taskId = Number(ctx.match[1]);
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId);
    if (!state?.voiceAction) return ctx.answerCbQuery('Сессия устарела.');
    const task = getTaskById(taskId);
    if (!task) return ctx.answerCbQuery('Задача не найдена.');
    const actionObj = state.voiceAction;
    delete state.voiceAction;
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await safeDelete(ctx);
    const { executeTaskAction } = require('./intent');
    await executeTaskAction(ctx, userId, task, actionObj);
  });

  // Фильтры задач
  bot.action('tf_cat', async (ctx) => {
    const userId     = getUser(ctx);
    const categories = getCategoryNames(userId);
    const rows = [];
    for (let i = 0; i < categories.length; i += 3) {
      rows.push(categories.slice(i, i + 3).map(c => Markup.button.callback(c, `tf_set_cat_${c}`)));
    }
    rows.push([Markup.button.callback('◀️ Назад', 'tf_back')]);
    await ctx.answerCbQuery();
    await safeEdit(ctx, '📁 Фильтр по категории:', Markup.inlineKeyboard(rows));
  });

  bot.action(/^tf_set_cat_(.+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const filter = getFilter(userId);
    filter.category = ctx.match[1];
    taskFilters.set(userId, filter);
    await ctx.answerCbQuery();
    await renderTaskListFiltered(ctx, userId, filter, true);
  });

  bot.action('tf_clear_cat', async (ctx) => {
    const userId = getUser(ctx);
    const filter = getFilter(userId);
    delete filter.category;
    taskFilters.set(userId, filter);
    await ctx.answerCbQuery();
    await renderTaskListFiltered(ctx, userId, filter, true);
  });

  const handleTfGoal = async (ctx) => {
    const userId = getUser(ctx);
    const goals  = getGoalsWithProgress(userId);
    if (!goals.length) return ctx.answerCbQuery('Целей нет.');
    const rows = goals.map(g => [Markup.button.callback(g.title, `tf_set_plan_${g.id}`)]);
    rows.push([Markup.button.callback('◀️ Назад', 'tf_back')]);
    await ctx.answerCbQuery();
    await safeEdit(ctx, '📎 Фильтр по цели:', Markup.inlineKeyboard(rows));
  };
  bot.action('tf_goal', handleTfGoal);
  bot.action('tf_plan', handleTfGoal);

  bot.action(/^tf_set_plan_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const goalId = Number(ctx.match[1]);
    const goal   = getGoalById(goalId);
    const filter = getFilter(userId);
    filter.goalId    = goalId;
    filter.goalTitle = goal?.title ?? 'Цель';
    // Legacy aliases
    filter.planId    = goalId;
    filter.planTitle = goal?.title ?? 'Цель';
    taskFilters.set(userId, filter);
    await ctx.answerCbQuery();
    await renderTaskListFiltered(ctx, userId, filter, true);
  });

  const handleTfClearGoal = async (ctx) => {
    const userId = getUser(ctx);
    const filter = getFilter(userId);
    delete filter.goalId;
    delete filter.goalTitle;
    delete filter.planId;
    delete filter.planTitle;
    taskFilters.set(userId, filter);
    await ctx.answerCbQuery();
    await renderTaskListFiltered(ctx, userId, filter, true);
  };
  bot.action('tf_clear_goal', handleTfClearGoal);
  bot.action('tf_clear_plan', handleTfClearGoal);

  bot.action('tf_search', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId) ?? {};
    state.searchingTasks = true;
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await safeEdit(ctx, '🔍 Введи текст для поиска по названию и описанию:', Markup.inlineKeyboard([
      [Markup.button.callback('◀️ Назад', 'tf_back')],
    ]));
  });

  bot.action('tf_clear_search', async (ctx) => {
    const userId = getUser(ctx);
    const filter = getFilter(userId);
    delete filter.search;
    taskFilters.set(userId, filter);
    await ctx.answerCbQuery();
    await renderTaskListFiltered(ctx, userId, filter, true);
  });

  bot.action('tf_back', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId) ?? {};
    delete state.searchingTasks;
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await renderTaskListFiltered(ctx, userId, getFilter(userId), true);
  });

  bot.action('tf_archived', async (ctx) => {
    const userId = getUser(ctx);
    const filter = getFilter(userId);
    filter.includeArchived = true;
    taskFilters.set(userId, filter);
    await ctx.answerCbQuery();
    await renderTaskListFiltered(ctx, userId, filter, true);
  });

  bot.action('tf_clear_archived', async (ctx) => {
    const userId = getUser(ctx);
    const filter = getFilter(userId);
    delete filter.includeArchived;
    taskFilters.set(userId, filter);
    await ctx.answerCbQuery();
    await renderTaskListFiltered(ctx, userId, filter, true);
  });

  // Подменю выбора статуса
  bot.action('tf_status', async (ctx) => {
    await ctx.answerCbQuery();
    await safeEdit(ctx, '📊 *Фильтр по статусу:*', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 В работе',    'tf_status_in_progress'),
         Markup.button.callback('⬜ Не начато',   'tf_status_not_started')],
        [Markup.button.callback('⏸ В ожидании',  'tf_status_waiting'),
         Markup.button.callback('✅ Выполненные', 'tf_status_done')],
        [Markup.button.callback('🔁 Все активные', 'tf_status_all')],
        [Markup.button.callback('◀️ Назад', 'tf_status_back')],
      ]),
    });
  });

  bot.action(/^tf_status_(in_progress|not_started|waiting|done|all)$/, async (ctx) => {
    const userId = getUser(ctx);
    const val    = ctx.match[1];
    const filter = getFilter(userId);
    if (val === 'all') {
      delete filter.status;
    } else {
      filter.status = val;
    }
    taskFilters.set(userId, filter);
    await ctx.answerCbQuery();
    await renderTaskListFiltered(ctx, userId, filter, true);
  });

  bot.action('tf_status_back', async (ctx) => {
    const userId = getUser(ctx);
    await ctx.answerCbQuery();
    await renderTaskListFiltered(ctx, userId, getFilter(userId), true);
  });

  bot.action('tf_clear_status', async (ctx) => {
    // Открываем подменю — пользователь сам выбирает новый статус
    await ctx.answerCbQuery();
    await safeEdit(ctx, '📊 *Фильтр по статусу:*', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 В работе',    'tf_status_in_progress'),
         Markup.button.callback('⬜ Не начато',   'tf_status_not_started')],
        [Markup.button.callback('⏸ В ожидании',  'tf_status_waiting'),
         Markup.button.callback('✅ Выполненные', 'tf_status_done')],
        [Markup.button.callback('🔁 Все активные', 'tf_status_all')],
        [Markup.button.callback('◀️ Назад', 'tf_status_back')],
      ]),
    });
  });

  // Групповые операции — подтверждение
  bot.action('bulk_confirm', async (ctx) => {
    const userId = getUser(ctx);
    if (!acquireProcessing(userId)) return ctx.answerCbQuery('⏳ Уже обрабатывается...');
    const state  = pendingTasks.get(userId);
    if (!state?.bulkAction) { releaseProcessing(userId); return ctx.answerCbQuery('Сессия устарела.'); }
    const { taskIds, action, status, plan, category, priority } = state.bulkAction;
    delete state.bulkAction;
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await safeEdit(ctx, '⏳ Выполняю...');
    const { PRIORITY_MAP } = require('../categoryService');
    const { getPlanByTitle } = require('../planService');
    let count = 0;
    for (const taskId of taskIds) {
      const task = getTaskById(taskId);
      if (!task) continue;
      switch (action) {
        case 'update_status':
          updateTask(taskId, { status });
          if (notionEnabled(userId) && task.notion_page_id) {
            updateTaskStatus(task.notion_page_id, status).catch(() => {});
          }
          break;
        case 'delete':
          deleteTask(taskId);
          if (notionEnabled(userId) && task.notion_page_id) {
            updateTaskStatus(task.notion_page_id, 'deleted').catch(() => {});
          }
          break;
        case 'assign_plan': {
          const planObj = getPlanByTitle(userId, plan);
          if (planObj) {
            const updated = updateTask(taskId, { plan_id: planObj.id });
            if (notionEnabled(userId) && updated.notion_page_id) {
              updateTaskFields(updated.notion_page_id, updated).catch(() => {});
            }
          }
          break;
        }
        case 'assign_category': {
          let cat = getCategoryByName(userId, category);
          if (!cat) cat = createCategory(userId, category);
          const updated = updateTask(taskId, { category_id: cat.id });
          if (notionEnabled(userId) && updated.notion_page_id) {
            updateTaskFields(updated.notion_page_id, updated).catch(() => {});
          }
          break;
        }
        case 'set_priority': {
          const updated = updateTask(taskId, { priority: PRIORITY_MAP[priority] ?? priority });
          if (notionEnabled(userId) && updated.notion_page_id) {
            updateTaskFields(updated.notion_page_id, updated).catch(() => {});
          }
          break;
        }
      }
      count++;
    }
    await safeEdit(ctx, `✅ Готово: обновлено *${count}* задач.`, { parse_mode: 'Markdown' });
    releaseProcessing(userId);
  });

  // Пакетное создание задач — слайдер
  bot.action('batch_do', async (ctx) => {
    const userId = getUser(ctx);
    if (!acquireProcessing(userId)) return ctx.answerCbQuery('⏳ Уже обрабатывается...');
    const state = pendingTasks.get(userId);
    if (!state?.batchTasks) { releaseProcessing(userId); return ctx.answerCbQuery('Сессия устарела.'); }

    await ctx.answerCbQuery();
    const parsed = state.batchTasks[state.batchIndex];
    try {
      const { createTask } = require('../taskService');
      const { normalizeWaiting } = require('../helpers');
      if (parsed.status === 'waiting') {
        const norm = normalizeWaiting(parsed.waiting_reason, parsed.waiting_until);
        parsed.waiting_reason = norm.waiting_reason;
        parsed.waiting_until  = norm.waiting_until;
      }
      const saved = createTask(userId, parsed);
      if (parsed.subtasks?.length) createSubtasks(saved.id, parsed.subtasks);
      state.batchCreated.push(saved);

      if (notionEnabled(userId)) {
        pushTask(saved)
          .then(async notionPageId => {
            await updateTask(saved.id, { notion_page_id: notionPageId });
            if (saved.status === 'waiting') updateTaskStatus(notionPageId, 'waiting').catch(() => {});
            if (parsed.subtasks?.length) {
              const subtasks = getSubtasks(saved.id);
              const mapping  = await syncSubtasksToNotion(notionPageId, subtasks);
              mapping.forEach(({ subtaskId, blockId }) => updateSubtask(subtaskId, { notion_block_id: blockId }));
            }
          })
          .catch(e => { console.error('Notion sync error:', e.message); logSyncError(userId, `Создание задачи "${saved.title}": ${e.message}`); });
      }
    } catch (e) {
      console.error(e);
      releaseProcessing(userId);
      return safeEdit(ctx, '❌ Ошибка при создании задачи.');
    }

    state.batchIndex++;
    pendingTasks.set(userId, state);
    releaseProcessing(userId);
    await showNextBatchTask(ctx, userId, state);
  });

  bot.action('batch_skip', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId);
    if (!state?.batchTasks) return ctx.answerCbQuery('Сессия устарела.');
    await ctx.answerCbQuery();
    state.batchIndex++;
    pendingTasks.set(userId, state);
    await showNextBatchTask(ctx, userId, state);
  });

  // Notion — синхронизировать все
  bot.action('notion_sync_all', async (ctx) => {
    const userId = getUser(ctx);
    if (!acquireProcessing(userId)) return ctx.answerCbQuery('⏳ Синхронизация уже идёт...');
    await ctx.answerCbQuery();
    await safeEdit(ctx, '🔄 Синхронизирую задачи с Notion...', { parse_mode: 'Markdown' });
    const tasks = getUnsyncedTasks(userId);
    if (tasks.length === 0) {
      return ctx.reply('✅ Все задачи уже синхронизированы с Notion.');
    }
    let synced = 0;
    let failed = 0;
    for (const task of tasks) {
      try {
        const notionPageId = await pushTask(task);
        if (notionPageId) {
          updateTask(task.id, { notion_page_id: notionPageId });
          synced++;
        }
      } catch (e) {
        console.error('Notion bulk sync error:', e.message);
        logSyncError(userId, `Bulk sync "${task.title}": ${e.message}`);
        failed++;
      }
    }
    const msg = failed > 0
      ? `✅ Синхронизировано: ${synced}\n⚠️ Ошибок: ${failed}`
      : `✅ Синхронизировано задач: ${synced}`;
    ctx.reply(msg);
    releaseProcessing(userId);
  });
}

module.exports = { register, finishWaiting, showNextBatchTask };
