const { Markup } = require('telegraf');
const { getUser, safeEdit, safeDelete } = require('../helpers');
const { pendingTasks } = require('../state');
const { formatStepsList } = require('../formatters');
const { stepsButtons } = require('../keyboards');
const { getTaskById } = require('../taskService');
const {
  getSubtasks, getSubtaskById, createSubtask, createSubtasks,
  updateSubtask, toggleSubtask, deleteSubtask, deleteAllSubtasks,
} = require('../subtaskService');
const { suggestSubtasks } = require('../parser');
const {
  isConfigured: notionConfigured,
  syncSubtasksToNotion, toggleSubtaskInNotion,
  appendSubtaskToNotion, deleteNotionBlock,
} = require('../integrations/notion');

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
    const sub      = toggleSubtask(subId);
    const task     = getTaskById(sub.task_id);
    const subtasks = getSubtasks(sub.task_id);
    if (notionConfigured() && task.notion_page_id && sub.notion_block_id) {
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
    const subId = Number(ctx.match[1]);
    const sub   = getSubtaskById(subId);
    if (!sub) return ctx.answerCbQuery('Шаг не найден.');
    if (notionConfigured() && sub.notion_block_id) {
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
      const preview = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
      const header  = existing.length > 0
        ? `🤖 *Обновлённый список шагов:*\n\n${preview}`
        : `🤖 *Предлагаемые шаги:*\n\n${preview}`;
      const buttons = existing.length > 0
        ? [
            [Markup.button.callback('🔄 Заменить все', `ai_steps_replace_${taskId}`), Markup.button.callback('➕ Добавить новые', `ai_steps_merge_${taskId}`)],
            [Markup.button.callback('❌ Отмена', `steps_${taskId}`)],
          ]
        : [
            [Markup.button.callback('✅ Добавить', `ai_steps_replace_${taskId}`), Markup.button.callback('❌ Отмена', `steps_${taskId}`)],
          ];
      await safeEdit(ctx, header, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    } catch (e) {
      console.error(e);
      await safeEdit(ctx, '❌ Не удалось сгенерировать шаги.');
    }
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
    if (notionConfigured() && task.notion_page_id) {
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
    if (newSteps.length > 0 && notionConfigured() && task.notion_page_id) {
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

module.exports = { register };
