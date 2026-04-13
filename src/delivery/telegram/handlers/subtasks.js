const { Markup } = require('telegraf');
const { getUser, safeEdit, safeDelete } = require('../../../shared/helpers');
const { pendingTasks } = require('../../../shared/state');
const { formatStepsList } = require('../formatters');
const { stepsButtons } = require('../keyboards');
const { getTaskById } = require('../../../application/tasks');
const {
  getSubtasks, getSubtaskById, createSubtask, createSubtasks,
  updateSubtask, toggleSubtask, deleteSubtask, deleteAllSubtasks,
} = require('../../../application/subtasks');
const { suggestSubtasks } = require('../../../infrastructure/ai/parser');
const {
  isConfigured: notionConfigured,
  syncSubtasksToNotion, toggleSubtaskInNotion,
  appendSubtaskToNotion, deleteNotionBlock,
} = require('../../../infrastructure/integrations/notion');
const { getNotionEnabled } = require('../../../application/settings');

function notionEnabled(userId) { return notionConfigured() && getNotionEnabled(userId); }

const APS_PAGE = 6;

function renderPendingSteps(ctx, userId, reply = false) {
  const state = pendingTasks.get(userId);
  if (!state?.pendingSteps) return;
  delete state.pendingStepSlider;
  const { taskId, steps, hasExisting, page = 0 } = state.pendingSteps;
  const total = steps.length;
  const totalPages = Math.ceil(total / APS_PAGE) || 1;
  const p = Math.min(page, totalPages - 1);
  state.pendingSteps.page = p;
  pendingTasks.set(userId, state);

  const header = `🤖 *${hasExisting ? 'Обновлённые шаги' : 'Предлагаемые шаги'} (${total}):*`;
  const pageItems = steps.slice(p * APS_PAGE, (p + 1) * APS_PAGE);
  const offset = p * APS_PAGE;

  const stepRows = pageItems.map((s, i) => [
    Markup.button.callback(`${offset + i + 1}. ${s}`, `aps_item_${offset + i}`),
  ]);

  const extraRows = [];
  if (total > 0) extraRows.push([Markup.button.callback(`▶️ Управлять (${total})`, 'aps_slider_0')]);
  if (totalPages > 1) {
    extraRows.push([
      Markup.button.callback('◀️', p > 0 ? `aps_page_${p - 1}` : 'aps_noop'),
      Markup.button.callback(`${p + 1} / ${totalPages}`, 'aps_noop'),
      Markup.button.callback('▶️', p < totalPages - 1 ? `aps_page_${p + 1}` : 'aps_noop'),
    ]);
  }
  extraRows.push([Markup.button.callback('➕ Добавить шаг', 'aps_add')]);

  const confirmRows = hasExisting
    ? [
        [Markup.button.callback(`🔄 Заменить все`, `ai_steps_replace_${taskId}`), Markup.button.callback(`➕ Добавить новые`, `ai_steps_merge_${taskId}`)],
        [Markup.button.callback('❌ Отмена', `steps_${taskId}`)],
      ]
    : [
        [Markup.button.callback(`✅ Сохранить (${total})`, `ai_steps_replace_${taskId}`), Markup.button.callback('❌ Отмена', `steps_${taskId}`)],
      ];

  const opts = { parse_mode: 'Markdown', ...Markup.inlineKeyboard([...stepRows, ...extraRows, ...confirmRows]) };
  return reply ? ctx.reply(header, opts) : safeEdit(ctx, header, opts);
}

function renderPendingStepSlider(ctx, userId, reply = false) {
  const state = pendingTasks.get(userId);
  if (!state?.pendingSteps || !state?.pendingStepSlider) return;
  const { taskId, steps } = state.pendingSteps;
  const total = steps.length;
  let { index } = state.pendingStepSlider;
  index = Math.max(0, Math.min(index, total - 1));
  state.pendingStepSlider.index = index;
  pendingTasks.set(userId, state);

  const step = steps[index];
  const counter = `_${index + 1} из ${total}_`;
  const nav = [
    Markup.button.callback('◀️', index > 0 ? 'aps_prev' : 'aps_noop'),
    Markup.button.callback('📋 К списку', 'aps_back'),
    Markup.button.callback('▶️', index < total - 1 ? 'aps_next' : 'aps_noop'),
  ];
  const text = `🤖 *Шаг* ${counter}\n\n☐ ${step}`;
  const opts = {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✏️ Изменить', 'aps_edit'), Markup.button.callback('🗑 Удалить', 'aps_del')],
      [
        Markup.button.callback('↑ Выше', index > 0 ? 'aps_up' : 'aps_noop'),
        Markup.button.callback('↓ Ниже', index < total - 1 ? 'aps_down' : 'aps_noop'),
      ],
      nav,
    ]),
  };
  return reply ? ctx.reply(text, opts) : safeEdit(ctx, text, opts);
}

function register(bot) {
  // Открыть список шагов
  bot.action(/^steps_(\d+)$/, async (ctx) => {
    const taskId   = Number(ctx.match[1]);
    const task     = getTaskById(taskId);
    const subtasks = getSubtasks(taskId);
    await ctx.answerCbQuery();
    await safeEdit(ctx, formatStepsList(task, subtasks), {
      parse_mode: 'Markdown',
      ...stepsButtons(taskId, subtasks),
    });
  });

  // Переключить шаг
  bot.action(/^step_toggle_(\d+)$/, async (ctx) => {
    const subId    = Number(ctx.match[1]);
    const userId   = getUser(ctx);
    const sub      = toggleSubtask(subId);
    const task     = getTaskById(sub.task_id);
    const subtasks = getSubtasks(sub.task_id);
    if (notionEnabled(userId) && task.notion_page_id && sub.notion_block_id) {
      toggleSubtaskInNotion(sub.notion_block_id, sub.is_done).catch(() => {});
    }
    await ctx.answerCbQuery();
    await safeEdit(ctx, formatStepsList(task, subtasks), {
      parse_mode: 'Markdown',
      ...stepsButtons(sub.task_id, subtasks),
    });
  });

  // Удалить шаг
  bot.action(/^step_del_(\d+)$/, async (ctx) => {
    const subId  = Number(ctx.match[1]);
    const userId = getUser(ctx);
    const sub    = getSubtaskById(subId);
    if (!sub) return ctx.answerCbQuery('Шаг не найден.');
    if (notionEnabled(userId) && sub.notion_block_id) {
      deleteNotionBlock(sub.notion_block_id).catch(() => {});
    }
    deleteSubtask(subId);
    const task     = getTaskById(sub.task_id);
    const subtasks = getSubtasks(sub.task_id);
    await ctx.answerCbQuery('🗑 Удалено');
    await safeEdit(ctx, formatStepsList(task, subtasks), {
      parse_mode: 'Markdown',
      ...stepsButtons(sub.task_id, subtasks),
    });
  });

  // Добавить шаг — запросить текст
  bot.action(/^step_add_(\d+)$/, async (ctx) => {
    const taskId = Number(ctx.match[1]);
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId) ?? {};
    state.addingStep = { taskId };
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await safeEdit(ctx, '✏️ Напиши название шага:', {
      ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Отмена', `steps_${taskId}`)]]),
    });
  });

  // Редактировать шаг — запросить текст
  bot.action(/^step_edit_(\d+)$/, async (ctx) => {
    const subId  = Number(ctx.match[1]);
    const userId = getUser(ctx);
    const sub    = getSubtaskById(subId);
    if (!sub) return ctx.answerCbQuery('Шаг не найден.');
    const state  = pendingTasks.get(userId) ?? {};
    state.editingStep = { subId, taskId: sub.task_id };
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await safeEdit(ctx, `✏️ Новое название шага:\nТекущее: \`${sub.title}\``, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Отмена', `steps_${sub.task_id}`)]]),
    });
  });

  // AI-предложение шагов
  bot.action(/^ai_steps_(\d+)$/, async (ctx) => {
    const taskId   = Number(ctx.match[1]);
    const task     = getTaskById(taskId);
    const existing = getSubtasks(taskId);
    await ctx.answerCbQuery();
    await safeEdit(ctx, '🤖 Генерирую шаги...', { parse_mode: 'Markdown' });
    try {
      const steps  = await suggestSubtasks(task.title, task.description, existing);
      const userId = getUser(ctx);
      const state  = pendingTasks.get(userId) ?? {};
      state.pendingSteps = { taskId, steps, hasExisting: existing.length > 0 };
      pendingTasks.set(userId, state);
      await renderPendingSteps(ctx, userId);
    } catch (e) {
      console.error(e);
      await safeEdit(ctx, '❌ Не удалось сгенерировать шаги.');
    }
  });

  // Список pending-шагов — открыть конкретный шаг в слайдере
  bot.action(/^aps_item_(\d+)$/, async (ctx) => {
    const index  = parseInt(ctx.match[1]);
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId) ?? {};
    if (!state.pendingSteps) return ctx.answerCbQuery('Сессия устарела.');
    state.pendingStepSlider = { index };
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await renderPendingStepSlider(ctx, userId);
  });

  // Список pending-шагов — открыть слайдер с начала
  bot.action(/^aps_slider_(\d+)$/, async (ctx) => {
    const index  = parseInt(ctx.match[1]);
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId) ?? {};
    if (!state.pendingSteps) return ctx.answerCbQuery('Сессия устарела.');
    state.pendingStepSlider = { index };
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await renderPendingStepSlider(ctx, userId);
  });

  // Список pending-шагов — пагинация
  bot.action(/^aps_page_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId) ?? {};
    if (!state.pendingSteps) return ctx.answerCbQuery('Сессия устарела.');
    state.pendingSteps.page = parseInt(ctx.match[1]);
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await renderPendingSteps(ctx, userId);
  });

  // Слайдер — назад к списку
  bot.action('aps_back', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId) ?? {};
    delete state.pendingStepSlider;
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await renderPendingSteps(ctx, userId);
  });

  // Слайдер — навигация
  bot.action('aps_prev', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId);
    if (!state?.pendingStepSlider) return ctx.answerCbQuery();
    state.pendingStepSlider.index = Math.max(0, state.pendingStepSlider.index - 1);
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await renderPendingStepSlider(ctx, userId);
  });
  bot.action('aps_next', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId);
    if (!state?.pendingStepSlider) return ctx.answerCbQuery();
    state.pendingStepSlider.index++;
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await renderPendingStepSlider(ctx, userId);
  });
  bot.action('aps_noop', ctx => ctx.answerCbQuery());

  // Слайдер — удалить текущий шаг
  bot.action('aps_del', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId) ?? {};
    if (!state.pendingSteps || !state.pendingStepSlider) return ctx.answerCbQuery('Сессия устарела.');
    const { index } = state.pendingStepSlider;
    state.pendingSteps.steps.splice(index, 1);
    await ctx.answerCbQuery('🗑 Удалено');
    if (state.pendingSteps.steps.length === 0) {
      delete state.pendingSteps;
      delete state.pendingStepSlider;
      pendingTasks.set(userId, state);
      return safeEdit(ctx, '❌ Нет шагов для добавления.');
    }
    state.pendingStepSlider.index = Math.min(index, state.pendingSteps.steps.length - 1);
    pendingTasks.set(userId, state);
    await renderPendingStepSlider(ctx, userId);
  });

  // Слайдер — редактировать текущий шаг
  bot.action('aps_edit', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId) ?? {};
    if (!state.pendingSteps || !state.pendingStepSlider) return ctx.answerCbQuery('Сессия устарела.');
    const { index } = state.pendingStepSlider;
    const current = state.pendingSteps.steps[index];
    state.editingPendingStep = index;
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await safeEdit(ctx, `✏️ *Новое название шага:*\nТекущее: \`${current}\``, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Отмена', 'aps_edit_cancel')]]),
    });
  });

  bot.action('aps_edit_cancel', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId) ?? {};
    delete state.editingPendingStep;
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    if (state.pendingStepSlider) await renderPendingStepSlider(ctx, userId);
    else await renderPendingSteps(ctx, userId);
  });

  // Слайдер — переместить шаг вверх
  bot.action('aps_up', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId);
    if (!state?.pendingSteps || !state?.pendingStepSlider) return ctx.answerCbQuery();
    const { index } = state.pendingStepSlider;
    if (index > 0) {
      const steps = state.pendingSteps.steps;
      [steps[index - 1], steps[index]] = [steps[index], steps[index - 1]];
      state.pendingStepSlider.index = index - 1;
      pendingTasks.set(userId, state);
    }
    await ctx.answerCbQuery();
    await renderPendingStepSlider(ctx, userId);
  });

  // Слайдер — переместить шаг вниз
  bot.action('aps_down', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId);
    if (!state?.pendingSteps || !state?.pendingStepSlider) return ctx.answerCbQuery();
    const { index } = state.pendingStepSlider;
    const steps = state.pendingSteps.steps;
    if (index < steps.length - 1) {
      [steps[index], steps[index + 1]] = [steps[index + 1], steps[index]];
      state.pendingStepSlider.index = index + 1;
      pendingTasks.set(userId, state);
    }
    await ctx.answerCbQuery();
    await renderPendingStepSlider(ctx, userId);
  });

  // Список — добавить новый шаг
  bot.action('aps_add', async (ctx) => {
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId) ?? {};
    if (!state.pendingSteps) return ctx.answerCbQuery('Сессия устарела.');
    state.addingPendingStep = true;
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await safeEdit(ctx, '✏️ Напиши название нового шага:', {
      ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Отмена', 'aps_back')]]),
    });
  });

  // Заменить все шаги AI-предложенными
  bot.action(/^ai_steps_replace_(\d+)$/, async (ctx) => {
    const taskId = Number(ctx.match[1]);
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId) ?? {};
    if (!state.pendingSteps) return ctx.answerCbQuery('Сессия устарела.');
    const { steps } = state.pendingSteps;
    delete state.pendingSteps;
    pendingTasks.set(userId, state);
    deleteAllSubtasks(taskId);
    createSubtasks(taskId, steps);
    const task     = getTaskById(taskId);
    const subtasks = getSubtasks(taskId);
    if (notionEnabled(userId) && task.notion_page_id) {
      syncSubtasksToNotion(task.notion_page_id, subtasks)
        .then(mapping => mapping.forEach(({ subtaskId, blockId }) => updateSubtask(subtaskId, { notion_block_id: blockId })))
        .catch(() => {});
    }
    await ctx.answerCbQuery('✅ Шаги обновлены');
    await safeEdit(ctx, formatStepsList(task, subtasks), {
      parse_mode: 'Markdown',
      ...stepsButtons(taskId, subtasks),
    });
  });

  // Добавить только новые шаги (дедупликация)
  bot.action(/^ai_steps_merge_(\d+)$/, async (ctx) => {
    const taskId = Number(ctx.match[1]);
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId) ?? {};
    if (!state.pendingSteps) return ctx.answerCbQuery('Сессия устарела.');
    const { steps } = state.pendingSteps;
    delete state.pendingSteps;
    pendingTasks.set(userId, state);
    const existing       = getSubtasks(taskId);
    const existingTitles = existing.map(s => s.title.toLowerCase().trim());
    const newSteps       = steps.filter(s => !existingTitles.includes(s.toLowerCase().trim()));
    const task           = getTaskById(taskId);
    if (newSteps.length > 0 && notionEnabled(userId) && task.notion_page_id) {
      for (const title of newSteps) {
        const newSub = createSubtask(taskId, title);
        appendSubtaskToNotion(task.notion_page_id, newSub)
          .then(blockId => { if (blockId) updateSubtask(newSub.id, { notion_block_id: blockId }); })
          .catch(() => {});
      }
    } else if (newSteps.length > 0) {
      createSubtasks(taskId, newSteps);
    }
    const subtasks = getSubtasks(taskId);
    await ctx.answerCbQuery(newSteps.length > 0 ? `✅ Добавлено новых: ${newSteps.length}` : 'Новых шагов нет');
    await safeEdit(ctx, formatStepsList(task, subtasks), {
      parse_mode: 'Markdown',
      ...stepsButtons(taskId, subtasks),
    });
  });
}

module.exports = { register, renderPendingSteps, renderPendingStepSlider };
