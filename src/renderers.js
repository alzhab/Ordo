const { Markup } = require('telegraf');
const { getTasks } = require('./taskService');
const { formatTaskText, formatPlanDetail } = require('./formatters');

async function renderTaskListFiltered(ctx, userId, filter = {}, edit = false) {
  const tasks = getTasks(userId, filter);

  const STATUS_LABEL = {
    in_progress: '🔄 В работе',
    not_started: '⬜ Не начато',
    waiting:     '⏸ В ожидании',
    done:        '✅ Выполненные',
  };

  const statusBtn = filter.status
    ? Markup.button.callback(`${STATUS_LABEL[filter.status]} ×`, 'tf_clear_status')
    : Markup.button.callback('📊 Статус', 'tf_status');

  const filterRow = [
    filter.category
      ? Markup.button.callback(`📁 ${filter.category} ×`, 'tf_clear_cat')
      : Markup.button.callback('📁 Категория', 'tf_cat'),
    statusBtn,
    (filter.goalId || filter.planId)
      ? Markup.button.callback(`📎 ${filter.goalTitle ?? filter.planTitle} ×`, 'tf_clear_goal')
      : Markup.button.callback('📎 Цель', 'tf_goal'),
  ];

  const secondRow = [
    filter.includeArchived
      ? Markup.button.callback('📦 Архив ×', 'tf_clear_archived')
      : Markup.button.callback('📦 Архив', 'tf_archived'),
    filter.search
      ? Markup.button.callback(`🔍 "${filter.search.slice(0, 8)}" ×`, 'tf_clear_search')
      : Markup.button.callback('🔍 Поиск', 'tf_search'),
  ];

  const taskRows = tasks.slice(0, 15).map((t, i) => [
    Markup.button.callback(formatTaskText(t, i + 1), `tv_${t.id}`),
  ]);

  const keyboard = Markup.inlineKeyboard([filterRow, secondRow, ...taskRows]);
  const headerLabel = filter.status ? STATUS_LABEL[filter.status] : '📋 Задачи';
  const text = tasks.length === 0
    ? `${headerLabel} (0)\n\n_Ничего не найдено._`
    : `${headerLabel} (${tasks.length}):`;

  const opts = { parse_mode: 'Markdown', ...keyboard };
  if (!edit) return ctx.reply(text, opts);
  try {
    return await ctx.editMessageText(text, opts);
  } catch (e) {
    if (e.description?.includes('message is not modified')) return;
    if (e.description?.includes('message to edit not found')) return ctx.reply(text, opts);
    throw e;
  }
}

async function renderGoalTaskList(ctx, goal, tasks, edit = false) {
  const taskRows = tasks.slice(0, 15).map((t, i) => [
    Markup.button.callback(formatTaskText(t, i + 1), `tvg_${goal.id}_${t.id}`),
  ]);
  taskRows.push([Markup.button.callback('◀️ К цели', `gv_${goal.id}`)]);
  const text = tasks.length
    ? `📎 *${goal.title}* — задачи (${tasks.length}):`
    : `📎 *${goal.title}*\n\n_Задач нет._`;
  const opts = { parse_mode: 'Markdown', ...Markup.inlineKeyboard(taskRows) };
  return edit ? ctx.editMessageText(text, opts) : ctx.reply(text, opts);
}

// Legacy alias
const renderPlanTaskList = renderGoalTaskList;

module.exports = { renderTaskListFiltered, renderGoalTaskList, renderPlanTaskList };
