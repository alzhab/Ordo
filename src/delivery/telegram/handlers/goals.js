const { Markup } = require('telegraf');
const { getUser, safeEdit, safeDelete } = require('../../../shared/helpers');
const { pendingTasks, acquireProcessing, releaseProcessing } = require('../../../shared/state');
const { logSyncError } = require('../../../application/notifications');
const { formatPlanLine, formatPlanDetail } = require('../formatters');
const { buildGoalsKeyboard } = require('../keyboards');
const { renderGoalTaskList } = require('../renderers');
const {
  createGoal, getGoalsWithProgress, getGoalById, getTasksByGoal,
  archiveGoal, deleteGoal, getArchivedGoals, restoreGoal, updateGoal,
} = require('../../../application/goals');
const {
  pushPlan, updatePlanFields, archiveNotionPage, unarchiveNotionPage,
  isPlansConfigured, pushTask, isConfigured: isTasksConfigured, updateTaskStatus,
} = require('../../../infrastructure/integrations/notion');
const { getNotionEnabled } = require('../../../application/settings');

function notionGoalsEnabled(userId) { return isPlansConfigured() && getNotionEnabled(userId); }
function notionTasksEnabled(userId) { return isTasksConfigured() && getNotionEnabled(userId); }

async function syncNewGoalToNotion(goal, userId = null) {
  if (!notionGoalsEnabled(userId)) return;
  try {
    const notionPageId = await pushPlan(goal);
    if (notionPageId) updateGoal(goal.id, { notion_page_id: notionPageId });
  } catch (e) {
    console.error('Notion goal sync error:', e.message);
    if (userId) logSyncError(userId, `Создание цели "${goal.title}": ${e.message}`);
  }
}

// Legacy alias
const syncNewPlanToNotion = syncNewGoalToNotion;

async function replyWithGoalsList(ctx, userId) {
  const goals = getGoalsWithProgress(userId);
  return ctx.reply(`📎 *Цели* (${goals.length}):`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buildGoalsKeyboard(goals)),
  });
}

// Legacy alias
const replyWithPlansList = replyWithGoalsList;

async function replyWithArchive(ctx, userId) {
  const goals = getArchivedGoals(userId);
  const rows = goals.flatMap(g => [
    [Markup.button.callback(`📎 ${g.title}`, `gv_${g.id}`)],
    [Markup.button.callback('♻️ Восстановить', `goal_restore_${g.id}`), Markup.button.callback('🗑 Удалить', `garc_del_${g.id}`)],
  ]);
  rows.push([Markup.button.callback('◀️ К целям', 'back_to_goals')]);
  if (goals.length === 0) {
    return ctx.reply(`📦 *Архив пуст*`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('◀️ К целям', 'back_to_goals')]]),
    });
  }
  return ctx.reply(`📦 *Архив целей* (${goals.length}):`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(rows),
  });
}

function register(bot) {
  // /goals
  bot.command('goals', (ctx) => {
    const userId = getUser(ctx);
    const goals = getGoalsWithProgress(userId);
    ctx.reply(`📎 *Цели* (${goals.length}):`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buildGoalsKeyboard(goals)),
    });
  });

  // Просмотр цели
  bot.action(/^gv_(\d+)$/, async (ctx) => {
    const goalId = Number(ctx.match[1]);
    const goal = getGoalById(goalId);
    if (!goal) return ctx.answerCbQuery('Цель не найдена.');
    const tasks = getTasksByGoal(goalId);
    await ctx.answerCbQuery();
    await safeDelete(ctx);
    const archiveBtn = goal.status === 'archived'
      ? Markup.button.callback('♻️ Восстановить', `goal_restore_${goalId}`)
      : Markup.button.callback('🗃 Архив', `goal_archive_${goalId}`);
    await ctx.reply(formatPlanDetail(goal, tasks), {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📋 Задачи', `goal_tasks_${goalId}`)],
        [Markup.button.callback('✏️ Изменить', `goal_edit_${goalId}`), archiveBtn],
        [Markup.button.callback('🗑 Удалить', `goal_delete_${goalId}`), Markup.button.callback('◀️ К целям', 'back_to_goals')],
      ]),
    });
  });

  // Задачи цели
  bot.action(/^goal_tasks_(\d+)$/, async (ctx) => {
    const goalId = Number(ctx.match[1]);
    const goal = getGoalById(goalId);
    if (!goal) return ctx.answerCbQuery('Цель не найдена.');
    const tasks = getTasksByGoal(goalId);
    await ctx.answerCbQuery();
    await renderGoalTaskList(ctx, goal, tasks, true);
  });

  // Создание цели через кнопку
  bot.action('goal_new', async (ctx) => {
    const userId = getUser(ctx);
    pendingTasks.set(userId, { ...(pendingTasks.get(userId) ?? {}), creatingPlan: true });
    await ctx.answerCbQuery();
    await ctx.reply('Введи название новой цели:', Markup.inlineKeyboard([
      [Markup.button.callback('Отмена', 'goal_cancel')],
    ]));
  });

  bot.action('goal_cancel', async (ctx) => {
    const userId = getUser(ctx);
    const state = pendingTasks.get(userId) ?? {};
    delete state.creatingPlan;
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await safeDelete(ctx);
  });

  bot.action('back_to_goals', async (ctx) => {
    const userId = getUser(ctx);
    await ctx.answerCbQuery();
    await safeDelete(ctx);
    await replyWithGoalsList(ctx, userId);
  });

  // Архивирование
  bot.action(/^goal_archive_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const goalId = Number(ctx.match[1]);
    const goal = getGoalById(goalId);
    archiveGoal(goalId);
    if (notionGoalsEnabled(userId) && goal?.notion_page_id) {
      archiveNotionPage(goal.notion_page_id).catch(e => { console.error('Notion sync error:', e.message); logSyncError(userId, `Архив цели "${goal.title}": ${e.message}`); });
    }
    await ctx.answerCbQuery('🗃 Архивировано');
    await safeDelete(ctx);
    await replyWithGoalsList(ctx, userId);
  });

  // Архив целей
  bot.action('goals_archive', async (ctx) => {
    const userId = getUser(ctx);
    await ctx.answerCbQuery();
    await safeDelete(ctx);
    await replyWithArchive(ctx, userId);
  });

  bot.action(/^goal_restore_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const goal = getGoalById(Number(ctx.match[1]));
    restoreGoal(Number(ctx.match[1]));
    if (notionGoalsEnabled(userId) && goal?.notion_page_id) {
      unarchiveNotionPage(goal.notion_page_id).catch(e => { console.error('Notion sync error:', e.message); logSyncError(userId, `Восстановление цели "${goal?.title}": ${e.message}`); });
    }
    await ctx.answerCbQuery(`♻️ "${goal?.title}" восстановлена`);
    await safeDelete(ctx);
    await replyWithArchive(ctx, userId);
  });

  bot.action(/^garc_del_(\d+)$/, async (ctx) => {
    const goalId = Number(ctx.match[1]);
    const goal = getGoalById(goalId);
    await ctx.answerCbQuery();
    await safeEdit(ctx, `🗑 Удалить *${goal.title}*?`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('Только цель', `garc_del_only_${goalId}`), Markup.button.callback('С задачами', `garc_del_tasks_${goalId}`)],
        [Markup.button.callback('◀️ Отмена', 'goals_archive')],
      ]),
    });
  });

  bot.action(/^garc_del_only_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const goalId = Number(ctx.match[1]);
    const goal = getGoalById(goalId);
    deleteGoal(goalId, false);
    if (notionGoalsEnabled(userId) && goal?.notion_page_id) {
      archiveNotionPage(goal.notion_page_id).catch(e => { console.error('Notion sync error:', e.message); logSyncError(userId, `Удаление цели "${goal.title}": ${e.message}`); });
    }
    await ctx.answerCbQuery('🗑 Удалено');
    await safeDelete(ctx);
    await replyWithArchive(ctx, userId);
  });

  bot.action(/^garc_del_tasks_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const goalId = Number(ctx.match[1]);
    const goal = getGoalById(goalId);
    const tasks = getTasksByGoal(goalId);
    deleteGoal(goalId, true);
    if (notionGoalsEnabled(userId) && goal?.notion_page_id) {
      archiveNotionPage(goal.notion_page_id).catch(e => { console.error('Notion sync error:', e.message); logSyncError(userId, `Удаление цели "${goal.title}": ${e.message}`); });
    }
    if (notionTasksEnabled(userId)) {
      for (const t of tasks) {
        if (t.notion_page_id) updateTaskStatus(t.notion_page_id, 'deleted').catch(() => {});
      }
    }
    await ctx.answerCbQuery('🗑 Удалено вместе с задачами');
    await safeDelete(ctx);
    await replyWithArchive(ctx, userId);
  });

  // Редактирование цели
  bot.action(/^goal_edit_(\d+)$/, async (ctx) => {
    const goalId = Number(ctx.match[1]);
    const goal = getGoalById(goalId);
    await ctx.answerCbQuery();
    await safeEdit(ctx, `✏️ *${goal.title}*\n\nЧто изменить?`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📝 Название', `goal_edit_title_${goalId}`), Markup.button.callback('📄 Описание', `goal_edit_desc_${goalId}`)],
        [Markup.button.callback('◀️ Назад', `gv_${goalId}`)],
      ]),
    });
  });

  bot.action(/^goal_edit_(title|desc)_(\d+)$/, async (ctx) => {
    const field  = ctx.match[1];
    const goalId = Number(ctx.match[2]);
    const userId = getUser(ctx);
    const goal   = getGoalById(goalId);
    const labels = { title: 'Название', desc: 'Описание' };
    const dbField  = field === 'desc' ? 'description' : 'title';
    const current  = goal[dbField];
    const state    = pendingTasks.get(userId) ?? {};
    state.editingPlan = { id: goalId, field: dbField };
    pendingTasks.set(userId, state);
    const currentLine = current ? `\nТекущее: \`${current}\`` : '';
    await ctx.answerCbQuery();
    await safeEdit(ctx, `✏️ *${labels[field]}*${currentLine}\n\nОтправь новое значение:`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', `goal_edit_${goalId}`)]]),
    });
  });

  bot.action(/^goal_delete_(\d+)$/, async (ctx) => {
    const goalId = Number(ctx.match[1]);
    const goal   = getGoalById(goalId);
    await ctx.answerCbQuery();
    await safeEdit(ctx, `🗑 Удалить цель *${goal.title}*?`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('Только цель', `goal_del_only_${goalId}`), Markup.button.callback('С задачами', `goal_del_tasks_${goalId}`)],
        [Markup.button.callback('◀️ Отмена', `gv_${goalId}`)],
      ]),
    });
  });

  bot.action(/^goal_del_only_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const goalId = Number(ctx.match[1]);
    const goal   = getGoalById(goalId);
    deleteGoal(goalId, false);
    if (notionGoalsEnabled(userId) && goal?.notion_page_id) {
      archiveNotionPage(goal.notion_page_id).catch(e => { console.error('Notion sync error:', e.message); logSyncError(userId, `Удаление цели "${goal.title}": ${e.message}`); });
    }
    await ctx.answerCbQuery('🗑 Удалено');
    await safeDelete(ctx);
    await replyWithGoalsList(ctx, userId);
  });

  bot.action(/^goal_del_tasks_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const goalId = Number(ctx.match[1]);
    const goal   = getGoalById(goalId);
    const tasks  = getTasksByGoal(goalId);
    deleteGoal(goalId, true);
    if (notionGoalsEnabled(userId) && goal?.notion_page_id) {
      archiveNotionPage(goal.notion_page_id).catch(e => { console.error('Notion sync error:', e.message); logSyncError(userId, `Удаление цели "${goal.title}": ${e.message}`); });
    }
    if (notionTasksEnabled(userId)) {
      for (const t of tasks) {
        if (t.notion_page_id) updateTaskStatus(t.notion_page_id, 'deleted').catch(() => {});
      }
    }
    await ctx.answerCbQuery('🗑 Удалено вместе с задачами');
    await safeDelete(ctx);
    await replyWithGoalsList(ctx, userId);
  });

  // Создание цели из AI-предложения
  bot.action('plan_confirm_create', async (ctx) => {
    const userId = getUser(ctx);
    if (!acquireProcessing(userId)) return ctx.answerCbQuery('⏳ Уже обрабатывается...');
    const state  = pendingTasks.get(userId);
    if (!state?.planData) { releaseProcessing(userId); return ctx.answerCbQuery('Сессия устарела.'); }
    const { planData } = state;

    await ctx.answerCbQuery();
    await safeEdit(ctx, '⏳ Создаю цель и задачи...');

    try {
      const { createTask, updateTask } = require('../../../application/tasks');
      const { createSubtasks } = require('../../../application/subtasks');
      const goal = createGoal(userId, { title: planData.title, description: planData.description });

      // Сначала создаём цель в Notion, ждём page_id для привязки задач
      let goalNotionPageId = null;
      if (notionGoalsEnabled(userId)) {
        goalNotionPageId = await pushPlan(goal);
        if (goalNotionPageId) updateGoal(goal.id, { notion_page_id: goalNotionPageId });
      }

      for (const t of planData.tasks) {
        const task = createTask(userId, {
          title:    t.title,
          category: t.category ?? null,
          priority: t.priority ?? null,
          plannedFor: t.plannedFor ?? null,
          goal_id:  goal.id,
        });
        if (t.subtasks?.length) createSubtasks(task.id, t.subtasks);

        // Sync задачи в Notion
        if (notionTasksEnabled(userId)) {
          const taskWithGoal = { ...task, goal_notion_page_id: goalNotionPageId };
          pushTask(taskWithGoal)
            .then(notionPageId => { if (notionPageId) updateTask(task.id, { notion_page_id: notionPageId }); })
            .catch(e => console.error('Notion task sync error:', e.message));
        }
      }
      pendingTasks.delete(userId);
      await safeEdit(ctx, `✅ Создана цель *${goal.title}* с ${planData.tasks.length} задачами!`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('📎 Открыть цель', `gv_${goal.id}`)]]),
      });
    } catch (e) {
      console.error(e);
      await safeEdit(ctx, '❌ Ошибка при создании цели.');
    } finally {
      releaseProcessing(userId);
    }
  });

  // ─── Legacy backwards-compat aliases (old "plan" callback names) ────────────

  // /plans command → same as /goals
  bot.command('plans', (ctx) => {
    const userId = getUser(ctx);
    const goals = getGoalsWithProgress(userId);
    ctx.reply(`📎 *Планы* (${goals.length}):`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buildGoalsKeyboard(goals)),
    });
  });

  // pv_N → same as gv_N
  bot.action(/^pv_(\d+)$/, async (ctx) => {
    const goalId = Number(ctx.match[1]);
    const goal = getGoalById(goalId);
    if (!goal) return ctx.answerCbQuery('План не найден.');
    const tasks = getTasksByGoal(goalId);
    await ctx.answerCbQuery();
    await safeDelete(ctx);
    const archiveBtn = goal.status === 'archived'
      ? Markup.button.callback('♻️ Восстановить', `goal_restore_${goalId}`)
      : Markup.button.callback('🗃 Архив', `goal_archive_${goalId}`);
    await ctx.reply(formatPlanDetail(goal, tasks), {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📋 Задачи', `plan_tasks_${goalId}`)],
        [Markup.button.callback('✏️ Изменить', `goal_edit_${goalId}`), archiveBtn],
        [Markup.button.callback('🗑 Удалить', `goal_delete_${goalId}`), Markup.button.callback('◀️ К планам', 'back_to_plans')],
      ]),
    });
  });

  // plan_tasks_N → same as goal_tasks_N
  bot.action(/^plan_tasks_(\d+)$/, async (ctx) => {
    const goalId = Number(ctx.match[1]);
    const goal = getGoalById(goalId);
    if (!goal) return ctx.answerCbQuery('План не найден.');
    const tasks = getTasksByGoal(goalId);
    await ctx.answerCbQuery();
    await renderGoalTaskList(ctx, goal, tasks, true);
  });

  // plan_new → same as goal_new
  bot.action('plan_new', async (ctx) => {
    const userId = getUser(ctx);
    pendingTasks.set(userId, { ...(pendingTasks.get(userId) ?? {}), creatingPlan: true });
    await ctx.answerCbQuery();
    await ctx.reply('Введи название нового плана:', Markup.inlineKeyboard([
      [Markup.button.callback('Отмена', 'goal_cancel')],
    ]));
  });

  // back_to_plans → same as back_to_goals
  bot.action('back_to_plans', async (ctx) => {
    const userId = getUser(ctx);
    await ctx.answerCbQuery();
    await safeDelete(ctx);
    await replyWithGoalsList(ctx, userId);
  });

  // plan_archive_N → same as goal_archive_N
  bot.action(/^plan_archive_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const goalId = Number(ctx.match[1]);
    const goal = getGoalById(goalId);
    archiveGoal(goalId);
    if (notionGoalsEnabled(userId) && goal?.notion_page_id) {
      archiveNotionPage(goal.notion_page_id).catch(e => { console.error('Notion sync error:', e.message); logSyncError(userId, `Архив плана "${goal.title}": ${e.message}`); });
    }
    await ctx.answerCbQuery('🗃 Архивировано');
    await safeDelete(ctx);
    await replyWithGoalsList(ctx, userId);
  });

  // plan_restore_N → same as goal_restore_N
  bot.action(/^plan_restore_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const goal = getGoalById(Number(ctx.match[1]));
    restoreGoal(Number(ctx.match[1]));
    if (notionGoalsEnabled(userId) && goal?.notion_page_id) {
      unarchiveNotionPage(goal.notion_page_id).catch(e => { console.error('Notion sync error:', e.message); logSyncError(userId, `Восстановление плана "${goal?.title}": ${e.message}`); });
    }
    await ctx.answerCbQuery(`♻️ "${goal?.title}" восстановлен`);
    await safeDelete(ctx);
    await replyWithArchive(ctx, userId);
  });

  // plans_archive → same as goals_archive
  bot.action('plans_archive', async (ctx) => {
    const userId = getUser(ctx);
    await ctx.answerCbQuery();
    await safeDelete(ctx);
    await replyWithArchive(ctx, userId);
  });

  // parc_del_only_N → same as garc_del_only_N
  bot.action(/^parc_del_only_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const goalId = Number(ctx.match[1]);
    const goal = getGoalById(goalId);
    deleteGoal(goalId, false);
    if (notionGoalsEnabled(userId) && goal?.notion_page_id) {
      archiveNotionPage(goal.notion_page_id).catch(e => { console.error('Notion sync error:', e.message); logSyncError(userId, `Удаление плана "${goal.title}": ${e.message}`); });
    }
    await ctx.answerCbQuery('🗑 Удалено');
    await safeDelete(ctx);
    await replyWithArchive(ctx, userId);
  });

  // parc_del_tasks_N → same as garc_del_tasks_N
  bot.action(/^parc_del_tasks_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const goalId = Number(ctx.match[1]);
    const goal = getGoalById(goalId);
    const tasks = getTasksByGoal(goalId);
    deleteGoal(goalId, true);
    if (notionGoalsEnabled(userId) && goal?.notion_page_id) {
      archiveNotionPage(goal.notion_page_id).catch(e => { console.error('Notion sync error:', e.message); logSyncError(userId, `Удаление плана "${goal.title}": ${e.message}`); });
    }
    if (notionTasksEnabled(userId)) {
      for (const t of tasks) {
        if (t.notion_page_id) updateTaskStatus(t.notion_page_id, 'deleted').catch(() => {});
      }
    }
    await ctx.answerCbQuery('🗑 Удалено вместе с задачами');
    await safeDelete(ctx);
    await replyWithArchive(ctx, userId);
  });

  // ─── End legacy aliases ───────────────────────────────────────────────────────

  // Уточнение голосовой команды — выбор цели
  bot.action(/^va_plan_(\d+)$/, async (ctx) => {
    const goalId = Number(ctx.match[1]);
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId);
    if (!state?.voicePlanAction) return ctx.answerCbQuery('Сессия устарела.');
    const goal = getGoalById(goalId);
    if (!goal) return ctx.answerCbQuery('Цель не найдена.');
    const action = state.voicePlanAction;
    delete state.voicePlanAction;
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await safeDelete(ctx);
    const { executeGoalAction } = require('./intent');
    await executeGoalAction(ctx, userId, goal, action);
  });
}

module.exports = { register, syncNewGoalToNotion, syncNewPlanToNotion, replyWithGoalsList, replyWithPlansList };
