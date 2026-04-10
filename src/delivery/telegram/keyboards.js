const { Markup } = require('telegraf');
const { formatPlanLine } = require('./formatters');

const confirmButtons = Markup.inlineKeyboard([
  [
    Markup.button.callback('✅ Создать', 'confirm'),
    Markup.button.callback('✏️ Изменить', 'edit_menu'),
    Markup.button.callback('❌ Отмена', 'cancel'),
  ],
]);

function taskButtons(taskId, status) {
  const buttons = [];
  if (status !== 'not_started') buttons.push(Markup.button.callback('⬜ Вернуть', `ts_not_started_${taskId}`));
  if (status !== 'in_progress') buttons.push(Markup.button.callback('🔄 В работу', `ts_in_progress_${taskId}`));
  if (status !== 'done')        buttons.push(Markup.button.callback('✅ Готово',   `ts_done_${taskId}`));
  buttons.push(Markup.button.callback('🗑', `ts_delete_${taskId}`));
  return buttons;
}

function taskDetailButtons(t, planId = null, notionLink = false) {
  const statusBtns = [];
  if (t.status !== 'not_started') statusBtns.push(Markup.button.callback('⬜ Вернуть',    `ts_not_started_${t.id}`));
  if (t.status !== 'in_progress') statusBtns.push(Markup.button.callback('🔄 В работу',  `ts_in_progress_${t.id}`));
  if (t.status !== 'done')        statusBtns.push(Markup.button.callback('✅ Готово',     `ts_done_${t.id}`));
  if (t.status !== 'waiting')     statusBtns.push(Markup.button.callback('⏸ В ожидании', `ts_waiting_${t.id}`));
  const backBtn = planId
    ? Markup.button.callback('◀️ К плану', `plan_tasks_${planId}`)
    : Markup.button.callback('◀️ К списку', 'back_to_tasks');
  const rows = [
    statusBtns,
    [Markup.button.callback('📋 Шаги', `steps_${t.id}`), Markup.button.callback('✏️ Изменить', `edit_saved_${t.id}`)],
    [Markup.button.callback('🗑 Удалить', `ts_delete_${t.id}`), backBtn],
  ];
  if (notionLink) {
    rows.push([Markup.button.callback('🔗 Привязать к Notion', `notion_link_${t.id}`)]);
  }
  return Markup.inlineKeyboard(rows);
}

function buildCategoryButtons(categories, withBack = false) {
  const fallback = ['Общее', 'Работа', 'Дом', 'Здоровье'];
  const list = categories.length > 0 ? categories : fallback;
  const rows = [];
  for (let i = 0; i < list.length; i += 3) {
    rows.push(list.slice(i, i + 3).map(c => Markup.button.callback(c, `cat_${c}`)));
  }
  if (withBack) rows.push([Markup.button.callback('◀️ Назад', 'edit_back')]);
  return Markup.inlineKeyboard(rows);
}

function buildGoalsKeyboard(goals) {
  const rows = goals.map(g => [Markup.button.callback(formatPlanLine(g), `gv_${g.id}`)]);
  rows.push([Markup.button.callback('➕ Новая цель', 'goal_new'), Markup.button.callback('📦 Архив', 'goals_archive')]);
  return rows;
}

// Legacy alias
function buildPlansKeyboard(plans) {
  return buildGoalsKeyboard(plans);
}

function stepsButtons(taskId, subtasks) {
  const rows = subtasks.map(s => [
    Markup.button.callback(`${s.is_done ? '☑' : '☐'} ${s.title}`, `step_toggle_${s.id}`),
    Markup.button.callback('✏️', `step_edit_${s.id}`),
    Markup.button.callback('🗑', `step_del_${s.id}`),
  ]);
  rows.push([
    Markup.button.callback('➕ Добавить шаг', `step_add_${taskId}`),
    Markup.button.callback('🤖 AI шаги',      `ai_steps_${taskId}`),
  ]);
  rows.push([Markup.button.callback('◀️ К задаче', `tv_${taskId}`)]);
  return Markup.inlineKeyboard(rows);
}

module.exports = {
  confirmButtons,
  taskButtons, taskDetailButtons,
  buildCategoryButtons, buildGoalsKeyboard, buildPlansKeyboard, stepsButtons,
};
