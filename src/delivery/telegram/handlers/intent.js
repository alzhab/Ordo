const { Markup } = require('telegraf');
const { getUser, parseFlexibleDate, extractDateFromText, normalizeWaiting, extractNotionPageId, parseReminderDatetime, parserReminderToUtc, utcToLocal, parseTimeInput } = require('../../../shared/helpers');
const { pendingTasks, taskFilters, getFilter } = require('../../../shared/state');
const { getSettings, updateSettings } = require('../../../application/settings');
const { formatRecurringSchedule } = require('../formatters');
const { computeNextOccurrence } = require('../../../infrastructure/db/repositories/taskRepository');
const { fuzzyMatch } = require('../../../shared/fuzzy');
const {
  STATUS_LABEL_RU,
  formatTaskDetail, formatPlanDetail,
  formatPlanSuggestion, formatBulkPreview, formatStepsList,
} = require('../formatters');
const { taskDetailButtons, stepsButtons } = require('../keyboards');
const { renderTaskListFiltered, renderPlanTaskList } = require('../renderers');
const { parseIntent } = require('../../../infrastructure/ai/parser');
const { transcribeVoice } = require('../../../infrastructure/ai/whisper');
const {
  getTasks, getTasksByPlannedDate, getTaskById, updateTask, deleteTask, saveTask, isNotionEnabled,
} = require('../../../application/tasks');
const {
  getGoalsWithProgress, getGoalById, getGoalByTitle, getTasksByGoal,
  archiveGoal, deleteGoal, createGoal,
} = require('../../../application/goals');
const { getCategoryNames, getCategoryByName, createCategory, getCategories, getCategoryTaskCount, deleteCategory } = require('../../../application/categories');
const {
  getSubtasks, createSubtasks, updateSubtask,
  appendSubtaskWithNotion, editSubtaskTitleWithNotion,
} = require('../../../application/subtasks');
const { isPlansConfigured } = require('../../../infrastructure/integrations/notion');
const { syncNewGoalToNotion } = require('./goals');
const { renderPendingSteps } = require('./subtasks');

// ─── Одиночные действия над задачей ──────────────────────

async function executeTaskAction(ctx, userId, task, actionObj) {
  const { action, status, plan, category, date } = actionObj;
  switch (action) {
    case 'update_status': {
      updateTask(task.id, { status }, userId);
      return ctx.reply(
        `${STATUS_LABEL_RU[status] ?? status}: *${task.title}*`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('Открыть', `tv_${task.id}`)]]) }
      );
    }
    case 'delete': {
      return ctx.reply(`🗑 Удалить *${task.title}*?`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[
          Markup.button.callback('Да, удалить', `ts_confirm_delete_${task.id}`),
          Markup.button.callback('Отмена', 'ts_cancel_delete'),
        ]]),
      });
    }
    case 'assign_plan': {
      const goalObj = getGoalByTitle(userId, plan);
      if (!goalObj) return ctx.reply(`Цель "${plan}" не найдена.`);
      updateTask(task.id, { goal_id: goalObj.id }, userId);
      return ctx.reply(`✅ *${task.title}* → цель *${goalObj.title}*`, { parse_mode: 'Markdown' });
    }
    case 'assign_category': {
      let cat = getCategoryByName(userId, category);
      if (!cat) cat = createCategory(userId, category);
      updateTask(task.id, { category_id: cat.id }, userId);
      return ctx.reply(`✅ *${task.title}* → категория *${category}*`, { parse_mode: 'Markdown' });
    }
    case 'set_planned_for': {
      updateTask(task.id, { planned_for: date }, userId);
      return ctx.reply(`✅ *${task.title}* → 📅 *${date}*`, { parse_mode: 'Markdown' });
    }
    case 'set_waiting': {
      const { waiting_reason, waiting_until } = normalizeWaiting(actionObj.waiting_reason, actionObj.waiting_until);
      updateTask(task.id, { status: 'waiting', waiting_reason, waiting_until }, userId);
      return ctx.reply(
        `⏸ *${task.title}* — в ожидании${actionObj.waiting_reason ? `\n_${actionObj.waiting_reason}_` : ''}`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('Открыть', `tv_${task.id}`)]]) }
      );
    }
    case 'set_reminder': {
      const tz = getSettings(userId).timezone;
      const reminderUtc = actionObj.reminder_at ? parserReminderToUtc(actionObj.reminder_at, tz) : null;
      updateTask(task.id, { reminder_at: reminderUtc, reminder_sent: 0 });
      const displayReminder = reminderUtc ? utcToLocal(reminderUtc, tz) : '—';
      return ctx.reply(
        `🔔 *${task.title}*\nНапомню: ${displayReminder.slice(0, 16)}`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('Открыть', `tv_${task.id}`)]]) }
      );
    }
    default:
      return ctx.reply('Не понял действие. Попробуй переформулировать.');
  }
}

async function handleManageTask(ctx, userId, parsed) {
  const allTasks = getTasks(userId);
  const tasks = allTasks.filter(t =>
    fuzzyMatch(t.title, parsed.search) ||
    (t.description && fuzzyMatch(t.description, parsed.search))
  );
  if (tasks.length === 0) {
    return ctx.reply(`Задача по запросу _"${parsed.search}"_ не найдена.`, { parse_mode: 'Markdown' });
  }
  if (tasks.length === 1) {
    return executeTaskAction(ctx, userId, tasks[0], parsed);
  }
  const state = pendingTasks.get(userId) ?? {};
  state.voiceAction = { action: parsed.action, status: parsed.status, plan: parsed.plan, category: parsed.category, date: parsed.date };
  pendingTasks.set(userId, state);
  const rows = tasks.slice(0, 8).map(t => [Markup.button.callback(t.title, `va_task_${t.id}`)]);
  rows.push([Markup.button.callback('❌ Отмена', 'cancel')]);
  return ctx.reply('Найдено несколько задач — выбери нужную:', Markup.inlineKeyboard(rows));
}

async function handleQueryTasks(ctx, userId, parsed) {
  if (parsed.date === 'today') {
    const today = new Date().toISOString().split('T')[0];
    const tasks = getTasksByPlannedDate(userId, today);
    if (tasks.length === 0) return ctx.reply('На сегодня задач не запланировано.');
    const { formatTaskText } = require('../formatters');
    const rows = tasks.slice(0, 15).map((t, i) => [Markup.button.callback(formatTaskText(t, i + 1), `tv_${t.id}`)]);
    return ctx.reply(`📅 *Задачи на сегодня (${tasks.length}):*`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
  }
  const filter = {};
  if (parsed.category) filter.category = parsed.category;
  if (parsed.status)   filter.status   = parsed.status;
  if (parsed.plan) {
    const goals = getGoalsWithProgress(userId);
    const goal  = goals.find(g => fuzzyMatch(g.title, parsed.plan));
    if (goal) { filter.goalId = goal.id; filter.goalTitle = goal.title; }
  }
  taskFilters.set(userId, filter);
  return renderTaskListFiltered(ctx, userId, filter);
}

async function executeGoalAction(ctx, userId, goal, action) {
  switch (action) {
    case 'archive':
      archiveGoal(goal.id);
      if (isPlansConfigured() && goal.notion_page_id) {
        const { archiveNotionPage } = require('../../../infrastructure/integrations/notion');
        archiveNotionPage(goal.notion_page_id).catch(e => console.error('Notion sync error:', e.message));
      }
      return ctx.reply(`🗃 Цель *${goal.title}* архивирована.`, { parse_mode: 'Markdown' });
    case 'delete':
      return ctx.reply(`🗑 Удалить цель *${goal.title}*?`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('Только цель', `goal_del_only_${goal.id}`), Markup.button.callback('С задачами', `goal_del_tasks_${goal.id}`)],
          [Markup.button.callback('◀️ Отмена', 'cancel')],
        ]),
      });
    case 'show_tasks': {
      const tasks = getTasksByGoal(goal.id);
      return renderPlanTaskList(ctx, goal, tasks);
    }
    default:
      return ctx.reply('Не понял действие с целью.');
  }
}

// Legacy alias
const executePlanAction = executeGoalAction;

async function handleManageGoal(ctx, userId, parsed) {
  const goals    = getGoalsWithProgress(userId);
  const matching = goals.filter(g => fuzzyMatch(g.title, parsed.search ?? ''));
  if (matching.length === 0) {
    return ctx.reply(`Цель _"${parsed.search}"_ не найдена.`, { parse_mode: 'Markdown' });
  }
  if (matching.length === 1) {
    return executeGoalAction(ctx, userId, matching[0], parsed.action);
  }
  const state = pendingTasks.get(userId) ?? {};
  state.voicePlanAction = parsed.action;
  pendingTasks.set(userId, state);
  const rows = matching.map(g => [Markup.button.callback(g.title, `va_plan_${g.id}`)]);
  rows.push([Markup.button.callback('❌ Отмена', 'cancel')]);
  return ctx.reply('Найдено несколько целей — выбери нужную:', Markup.inlineKeyboard(rows));
}

// Legacy alias
const handleManagePlan = handleManageGoal;

function resolveTaskScope(allTasks, parsed) {
  let tasks = [...allTasks];
  const f = parsed.filter ?? {};
  if (f.category) tasks = tasks.filter(t => fuzzyMatch(t.category_name ?? '', f.category));
  if (f.plan)     tasks = tasks.filter(t => fuzzyMatch(t.goal_title ?? '', f.plan));
  if (f.status)   tasks = tasks.filter(t => t.status === f.status);
  if (f.search)   tasks = tasks.filter(t =>
    fuzzyMatch(t.title, f.search) || (t.description && fuzzyMatch(t.description, f.search))
  );
  switch (parsed.scope) {
    case 'first_n': return tasks.slice(0, parsed.n ?? 1);
    case 'last_n':  return tasks.slice(-(parsed.n ?? 1));
    case 'half':    return tasks.slice(0, Math.ceil(tasks.length / 2));
    default:        return tasks;
  }
}

async function handleManageTasksBulk(ctx, userId, parsed) {
  const allTasks = getTasks(userId);
  const tasks    = resolveTaskScope(allTasks, parsed);
  if (tasks.length === 0) return ctx.reply('Задач по заданным критериям не найдено.');
  const state = pendingTasks.get(userId) ?? {};
  state.bulkAction = {
    taskIds:  tasks.map(t => t.id),
    action:   parsed.action,
    status:   parsed.status,
    plan:     parsed.plan,
    category: parsed.category,
  };
  pendingTasks.set(userId, state);
  return ctx.reply(formatBulkPreview(tasks, parsed.action, parsed), {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Подтвердить', 'bulk_confirm'), Markup.button.callback('❌ Отмена', 'cancel')],
    ]),
  });
}

async function handleManageCategory(ctx, userId, parsed) {
  const { action, name } = parsed;

  if (action === 'list') {
    const cats = getCategories(userId);
    if (cats.length === 0) return ctx.reply('Категорий нет.');
    const lines = cats.map(c => {
      const cnt = getCategoryTaskCount(c.id);
      return `📁 *${c.name}*${cnt > 0 ? ` — ${cnt} задач` : ''}`;
    }).join('\n');
    return ctx.reply(lines, { parse_mode: 'Markdown' });
  }

  if (action === 'create') {
    if (!name) return ctx.reply('Укажи название категории.');
    const existing = getCategoryByName(userId, name);
    if (existing) return ctx.reply(`Категория *${name}* уже существует.`, { parse_mode: 'Markdown' });
    const cat = createCategory(userId, name);
    return ctx.reply(`✅ Категория *${cat.name}* создана!`, { parse_mode: 'Markdown' });
  }

  if (action === 'delete') {
    if (!name) return ctx.reply('Укажи название категории для удаления.');
    const cat = getCategoryByName(userId, name);
    if (!cat) return ctx.reply(`Категория _"${name}"_ не найдена.`, { parse_mode: 'Markdown' });
    const count = getCategoryTaskCount(cat.id);
    if (count > 0) {
      return ctx.reply(`⚠️ Категория *${cat.name}* содержит ${count} активных задач. Сначала перенеси или удали задачи.`, { parse_mode: 'Markdown' });
    }
    deleteCategory(cat.id);
    return ctx.reply(`🗑 Категория *${cat.name}* удалена.`, { parse_mode: 'Markdown' });
  }

  return ctx.reply('Не понял действие с категорией.');
}

// ─── Главный обработчик текста ────────────────────────────

async function handleText(ctx, text) {
  const userId = getUser(ctx);
  const state  = pendingTasks.get(userId);

  // Добавление шага
  if (state?.addingStep) {
    const { taskId } = state.addingStep;
    delete state.addingStep;
    pendingTasks.set(userId, state);
    await appendSubtaskWithNotion(userId, taskId, text);
    const task     = getTaskById(taskId);
    const subtasks = getSubtasks(taskId);
    return ctx.reply(formatStepsList(task, subtasks), {
      parse_mode: 'Markdown',
      ...stepsButtons(taskId, subtasks),
    });
  }

  // Редактирование шага
  if (state?.editingStep) {
    const { subId, taskId } = state.editingStep;
    delete state.editingStep;
    pendingTasks.set(userId, state);
    const updatedSub = await editSubtaskTitleWithNotion(userId, subId, text);
    const task     = getTaskById(taskId);
    const subtasks = getSubtasks(taskId);
    return ctx.reply(formatStepsList(task, subtasks), {
      parse_mode: 'Markdown',
      ...stepsButtons(taskId, subtasks),
    });
  }

  // Редактирование pending AI-шага
  if (state?.editingPendingStep) {
    const { index } = state.editingPendingStep;
    delete state.editingPendingStep;
    if (state.pendingSteps?.steps) {
      state.pendingSteps.steps[index] = text.trim();
    }
    pendingTasks.set(userId, state);
    return renderPendingSteps(ctx, userId, true);
  }

  // Поиск по задачам
  if (state?.searchingTasks) {
    delete state.searchingTasks;
    pendingTasks.set(userId, state);
    const filter  = getFilter(userId);
    filter.search = text;
    taskFilters.set(userId, filter);
    return renderTaskListFiltered(ctx, userId, filter);
  }

  // Редактирование цели
  if (state?.editingPlan?.field) {
    const { id, field } = state.editingPlan;
    delete state.editingPlan;
    pendingTasks.set(userId, state);
    const { updateGoal } = require('../../../application/goals');
    const updated = updateGoal(id, { [field]: text });
    if (isPlansConfigured() && updated.notion_page_id) {
      updatePlanFields(updated.notion_page_id, updated).catch(e => console.error('Notion sync error:', e.message));
    }
    const goal  = getGoalById(id);
    const tasks = getTasksByGoal(id);
    return ctx.reply(formatPlanDetail(goal, tasks), {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📋 Задачи', `goal_tasks_${id}`)],
        [Markup.button.callback('✏️ Изменить', `goal_edit_${id}`), Markup.button.callback('🗃 Архив', `goal_archive_${id}`)],
        [Markup.button.callback('🗑 Удалить', `goal_delete_${id}`), Markup.button.callback('◀️ К целям', 'back_to_goals')],
      ]),
    });
  }

  // Создание цели через текст
  if (state?.creatingPlan) {
    delete state.creatingPlan;
    pendingTasks.set(userId, state);
    const goal = createGoal(userId, { title: text });
    syncNewGoalToNotion(goal);
    return ctx.reply(`✅ Цель *${goal.title}* создана!`, { parse_mode: 'Markdown' });
  }

  // Двухшаговый диалог ожидания
  if (state?.settingWaiting) {
    const sw = state.settingWaiting;
    if (sw.step === 'reason') {
      sw.waiting_reason = text.trim();
      // Если в тексте причины есть дата — сразу используем её, пропускаем шаг 'until'
      const dateInReason = extractDateFromText(text);
      if (dateInReason) {
        return require('./tasks').finishWaiting(ctx, userId, state, dateInReason);
      }
      sw.step = 'until';
      pendingTasks.set(userId, state);
      return ctx.reply('⏸ До какой даты ждёшь? (например: "25 марта", "через неделю")\n\nИли напиши /skip чтобы пропустить.', {
        ...Markup.inlineKeyboard([[Markup.button.callback('Пропустить', `tw_skip_${sw.taskId}`)]]),
      });
    } else {
      // step === 'until'
      const waitingUntil = parseFlexibleDate(text);
      return require('./tasks').finishWaiting(ctx, userId, state, waitingUntil);
    }
  }

  // Привязка к Notion странице
  if (state?.linkingNotion?.taskId) {
    const { taskId } = state.linkingNotion;
    delete state.linkingNotion;
    pendingTasks.set(userId, state);
    const pageId = extractNotionPageId(text);
    if (!pageId) return ctx.reply('❌ Не удалось распознать Notion page ID. Отправь URL страницы или ID в формате UUID.');
    const updated = updateTask(taskId, { notion_page_id: pageId });
    return ctx.reply(formatTaskDetail(updated, getSettings(userId).timezone), {
      parse_mode: 'Markdown',
      ...taskDetailButtons(updated, null, false),
    });
  }

  // Ввод времени уведомления (план или разбор)
  if (state?.awaitingSettingInput) {
    const field = state.awaitingSettingInput;
    delete state.awaitingSettingInput;
    pendingTasks.set(userId, state);
    const time = parseTimeInput(text);
    if (!time) {
      return ctx.reply('Не понял время. Попробуй: `9:00`, `21:30`, `в 8 утра`', { parse_mode: 'Markdown' });
    }
    updateSettings(userId, { [field]: time });
    const label = field === 'plan_time' ? '📋 /plan' : '🔍 /review';
    await ctx.reply(`✅ ${label} теперь в *${time}*`, { parse_mode: 'Markdown' });
    const { buildSettingsText, buildSettingsKeyboard } = require('./settings');
    return ctx.reply(buildSettingsText(userId), { parse_mode: 'Markdown', ...buildSettingsKeyboard(userId) });
  }

  // Создание категории через текст
  if (state?.creatingCategory) {
    delete state.creatingCategory;
    pendingTasks.set(userId, state);
    const cat = createCategory(userId, text.trim());
    const { buildSettingsText, buildSettingsKeyboard } = require('./settings');
    await ctx.reply(`✅ Категория *${cat.name}* создана!`, { parse_mode: 'Markdown' });
    return ctx.reply(buildSettingsText(), { parse_mode: 'Markdown', ...buildSettingsKeyboard() });
  }

  // Редактирование сохранённой задачи
  if (state?.editingSavedTask?.field) {
    const { id, field } = state.editingSavedTask;
    delete state.editingSavedTask;
    pendingTasks.set(userId, state);
    const tz = getSettings(userId).timezone;
    let value;
    if (field === 'reminder_at') value = parseReminderDatetime(text, tz);
    else if (field === 'planned_for' || field === 'waiting_until') value = parseFlexibleDate(text, tz);
    else value = text;
    const fields = field === 'reminder_at'
      ? { reminder_at: value, reminder_sent: 0 }
      : { [field]: value };
    const updated = updateTask(id, fields, userId);
    return ctx.reply(formatTaskDetail(updated, tz), { parse_mode: 'Markdown', ...taskDetailButtons(updated, null, isNotionEnabled(userId) && !updated.notion_page_id) });
  }

  // Парсинг нового намерения
  const statusMsg = await ctx.reply('⏳ Анализирую...');
  let parsed;
  const timezone = getSettings(userId).timezone;
  try {
    const categories = getCategoryNames(userId);
    const goalNames  = getGoalsWithProgress(userId).map(g => g.title);
    parsed = await parseIntent(text, categories, goalNames, timezone);
  } catch (e) {
    console.error(e);
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
    return ctx.reply('Не удалось распознать сообщение. Попробуй сформулировать подробнее.');
  }

  await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);

  if (parsed.intent === 'manage_task')       return handleManageTask(ctx, userId, parsed);
  if (parsed.intent === 'manage_tasks_bulk') return handleManageTasksBulk(ctx, userId, parsed);
  if (parsed.intent === 'query_tasks')       return handleQueryTasks(ctx, userId, parsed);
  if (parsed.intent === 'manage_goal' || parsed.intent === 'manage_plan') return handleManageGoal(ctx, userId, parsed);
  if (parsed.intent === 'manage_category')   return handleManageCategory(ctx, userId, parsed);
  if (parsed.intent === 'manage_settings')   return handleManageSettings(ctx, userId, parsed);
  if (parsed.intent === 'create_recurring')       return handleCreateRecurring(ctx, userId, parsed);
  if (parsed.intent === 'create_recurring_batch') return handleCreateRecurringBatch(ctx, userId, parsed);

  if (parsed.intent === 'create_goal' || parsed.intent === 'create_plan') {
    const goal = createGoal(userId, { title: parsed.title, description: parsed.description });
    syncNewGoalToNotion(goal);
    return ctx.reply(`✅ Цель *${goal.title}* создана!`, { parse_mode: 'Markdown' });
  }

  if (parsed.intent === 'suggest_goal' || parsed.intent === 'suggest_plan') {
    pendingTasks.set(userId, { planData: parsed, editingField: null });
    return ctx.reply(formatPlanSuggestion(parsed), {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Создать всё', 'plan_confirm_create'), Markup.button.callback('❌ Отмена', 'cancel')],
      ]),
    });
  }

  if (parsed.intent === 'create_tasks_batch') {
    const batchTasks = [...(parsed.tasks ?? [])];
    if (batchTasks.length === 0) return ctx.reply('Не удалось распознать задачи. Попробуй ещё раз.');
    if (batchTasks.length === 1) {
      return saveAndReply(ctx, userId, batchTasks[0], timezone);
    }
    const state = { batchTasks, batchIndex: 0, batchCreated: [] };
    pendingTasks.set(userId, state);
    return require('./tasks').showNextBatchTask(ctx, userId, state, false);
  }

  return saveAndReply(ctx, userId, parsed, timezone);
}

// Сохраняет задачу немедленно и показывает сообщение с кнопками "Изменить" / "Отменить".
// Заменяет старый паттерн "превью → подтверждение" для одиночных задач.
async function saveAndReply(ctx, userId, parsed, timezone) {
  if (!parsed.title) return ctx.reply('Не удалось распознать задачу. Попробуй ещё раз.');
  const task = { ...parsed };
  if (task.status === 'waiting') {
    const norm = normalizeWaiting(task.waiting_reason, task.waiting_until);
    task.waiting_reason = norm.waiting_reason;
    task.waiting_until  = norm.waiting_until;
  }
  if (task.reminder_at) {
    task.reminder_at = parserReminderToUtc(task.reminder_at, timezone);
  }
  const saved = saveTask(userId, task);

  const rows = [];
  if (!task.subtasks?.length) {
    rows.push([Markup.button.callback('🤖 Предложить шаги', `ai_steps_${saved.id}`)]);
  }
  rows.push([Markup.button.callback('📋 Открыть задачу', `tv_${saved.id}`)]);
  rows.push([
    Markup.button.callback('✏️ Изменить', `edit_saved_${saved.id}`),
    Markup.button.callback('🗑 Отменить', `undo_task_${saved.id}`),
  ]);
  return ctx.reply(`✅ *${saved.title}* — сохранено`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(rows),
  });
}

function createRecurringTask(userId, parsed) {
  const recurDays  = parsed.days ? JSON.stringify(parsed.days) : null;
  const recurDom   = parsed.day_of_month ?? null;
  const plannedFor = computeNextOccurrence(recurDays, recurDom, false);
  return saveTask(userId, {
    title:               parsed.title,
    status:              'todo',
    is_recurring:        1,
    recur_time:          parsed.event_time,
    recur_days:          recurDays,
    recur_day_of_month:  recurDom,
    recur_remind_before: parsed.reminder_before_minutes ?? 0,
    plannedFor,
  });
}

function handleCreateRecurring(ctx, userId, parsed) {
  const task     = createRecurringTask(userId, parsed);
  const schedule = formatRecurringSchedule(task);
  return ctx.reply(
    `✅ *${task.title}* — повторяющееся\n${schedule}`,
    { parse_mode: 'Markdown' }
  );
}

function handleCreateRecurringBatch(ctx, userId, parsed) {
  const items = parsed.recurrings ?? [];
  if (!items.length) return ctx.reply('Не удалось распознать расписания. Попробуй ещё раз.');
  const lines = [];
  for (const item of items) {
    if (!item.title) continue;
    const task     = createRecurringTask(userId, item);
    const schedule = formatRecurringSchedule(task);
    lines.push(`✅ *${task.title}* — ${schedule}`);
  }
  if (!lines.length) return ctx.reply('Не удалось создать напоминания. Попробуй ещё раз.');
  return ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
}

function handleManageSettings(ctx, userId, parsed) {
  const { action, time, until } = parsed;

  switch (action) {
    case 'set_plan_time':
      updateSettings(userId, { plan_time: time });
      return ctx.reply(`✅ /plan теперь в *${time}*`, { parse_mode: 'Markdown' });

    case 'set_review_time':
      updateSettings(userId, { review_time: time });
      return ctx.reply(`✅ /review теперь в *${time}*`, { parse_mode: 'Markdown' });

    case 'set_quiet_mode': {
      const untilStr = until || new Date(Date.now() + 86400000).toISOString();
      updateSettings(userId, { quiet_until: untilStr });
      const d = new Date(untilStr);
      const fmt = `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      return ctx.reply(`🔕 Тихий режим до ${fmt}. Напоминания не приду.`);
    }

    case 'disable_plan':
      updateSettings(userId, { plan_enabled: 0 });
      return ctx.reply('🔕 /plan отключён. Включить: напиши "включи план".');

    case 'enable_plan':
      updateSettings(userId, { plan_enabled: 1 });
      return ctx.reply('✅ /plan включён.');

    case 'disable_review':
      updateSettings(userId, { review_enabled: 0 });
      return ctx.reply('🔕 /review отключён.');

    case 'enable_review':
      updateSettings(userId, { review_enabled: 1 });
      return ctx.reply('✅ /review включён.');

    case 'disable_all':
      updateSettings(userId, { plan_enabled: 0, review_enabled: 0 });
      return ctx.reply('🔕 Все автоматические уведомления отключены.');

    case 'enable_all':
      updateSettings(userId, { plan_enabled: 1, review_enabled: 1, quiet_until: null });
      return ctx.reply('✅ Все уведомления включены.');

    default:
      return ctx.reply('Не понял настройку. Попробуй: "поставь план на 9 утра" или "не беспокой до завтра".');
  }
}

function register(bot) {
  bot.on('text',  (ctx) => handleText(ctx, ctx.message.text));
  bot.on('voice', async (ctx) => {
    const statusMsg = await ctx.reply('🎙 Распознаю речь...');
    let text;
    try {
      const fileLink = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
      text = await transcribeVoice(fileLink.href);
    } catch (e) {
      console.error('Voice error:', e);
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
      return ctx.reply('Не удалось распознать голосовое сообщение.');
    }
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
    await ctx.reply(`🎙 Распознано: _${text}_`, { parse_mode: 'Markdown' });
    await handleText(ctx, text);
  });
}

module.exports = { register, executeTaskAction, executeGoalAction, executePlanAction, handleText };
