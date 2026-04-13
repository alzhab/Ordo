const { Markup } = require('telegraf');
const { getTasks } = require('../../application/tasks');
const { formatTaskText, formatPlanDetail } = require('./formatters');

const PAGE_SIZE = 6;

async function renderTaskListFiltered(ctx, userId, filter = {}, edit = false) {
  const tasks = getTasks(userId, filter);

  // Пагинация — автосброс если страница вышла за пределы
  let page = filter.page ?? 0;
  const totalPages = Math.ceil(tasks.length / PAGE_SIZE) || 1;
  if (page >= totalPages) { page = 0; filter.page = 0; }
  const pageTasks = tasks.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

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
    filter.plannedToday
      ? Markup.button.callback('📅 Сегодня ×', 'tf_clear_today')
      : Markup.button.callback('📅 Сегодня', 'tf_today'),
    filter.includeArchived
      ? Markup.button.callback('📦 Архив ×', 'tf_clear_archived')
      : Markup.button.callback('📦 Архив', 'tf_archived'),
    filter.search
      ? Markup.button.callback(`🔍 "${filter.search.slice(0, 8)}" ×`, 'tf_clear_search')
      : Markup.button.callback('🔍 Поиск', 'tf_search'),
  ];

  const thirdRow = [
    filter.isRecurring
      ? Markup.button.callback('🔄 Повторяющиеся ×', 'tf_clear_recurring')
      : Markup.button.callback('🔄 Повторяющиеся', 'tf_recurring'),
  ];

  const taskRows = pageTasks.map((t, i) => [
    Markup.button.callback(formatTaskText(t, page * PAGE_SIZE + i + 1), `tv_${t.id}`),
  ]);

  const extraRows = [];

  // Пагинация (только если > 1 страница)
  if (totalPages > 1) {
    extraRows.push([
      Markup.button.callback('◀️', page > 0 ? `tf_page_${page - 1}` : 'tf_noop'),
      Markup.button.callback(`${page + 1} / ${totalPages}`, 'tf_noop'),
      Markup.button.callback('▶️', page < totalPages - 1 ? `tf_page_${page + 1}` : 'tf_noop'),
    ]);
  }

  // Кнопка слайдера (только если есть задачи)
  if (tasks.length > 0) {
    extraRows.push([Markup.button.callback(`▶️ Просмотр (${tasks.length})`, 'tf_slider')]);
  }

  const keyboard = Markup.inlineKeyboard([filterRow, secondRow, thirdRow, ...taskRows, ...extraRows]);
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
