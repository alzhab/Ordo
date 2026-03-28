const { Markup } = require('telegraf');
const { getUser, safeEdit, safeDelete } = require('../helpers');
const { pendingTasks, acquireProcessing, releaseProcessing } = require('../state');
const { logSyncError } = require('../syncErrorService');
const { formatPlanLine, formatPlanDetail } = require('../formatters');
const { buildPlansKeyboard } = require('../keyboards');
const { renderPlanTaskList } = require('../renderers');
const {
  createPlan, getPlansWithProgress, getPlanById, getTasksByPlan,
  archivePlan, deletePlan, getArchivedPlans, restorePlan, updatePlan,
} = require('../planService');
const {
  pushPlan, updatePlanFields, archiveNotionPage, unarchiveNotionPage,
  isPlansConfigured, pushTask, isConfigured: isTasksConfigured, updateTaskStatus,
} = require('../integrations/notion');
const { getNotionEnabled } = require('../assistantService');

function notionPlansEnabled(userId) { return isPlansConfigured() && getNotionEnabled(userId); }
function notionTasksEnabled(userId) { return isTasksConfigured() && getNotionEnabled(userId); }

async function syncNewPlanToNotion(plan, userId = null) {
  if (!notionPlansEnabled(userId)) return;
  try {
    const notionPageId = await pushPlan(plan);
    if (notionPageId) updatePlan(plan.id, { notion_page_id: notionPageId });
  } catch (e) {
    console.error('Notion plan sync error:', e.message);
    if (userId) logSyncError(userId, `Создание плана "${plan.title}": ${e.message}`);
  }
}

async function replyWithPlansList(ctx, userId) {
  const plans = getPlansWithProgress(userId);
  return ctx.reply(`📋 *Планы* (${plans.length}):`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buildPlansKeyboard(plans)),
  });
}

async function replyWithArchive(ctx, userId) {
  const plans = getArchivedPlans(userId);
  const rows = plans.flatMap(p => [
    [Markup.button.callback(`📋 ${p.title}`, `pv_${p.id}`)],
    [Markup.button.callback('♻️ Восстановить', `plan_restore_${p.id}`), Markup.button.callback('🗑 Удалить', `parc_del_${p.id}`)],
  ]);
  rows.push([Markup.button.callback('◀️ К планам', 'back_to_plans')]);
  if (plans.length === 0) {
    return ctx.reply(`📦 *Архив пуст*`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('◀️ К планам', 'back_to_plans')]]),
    });
  }
  return ctx.reply(`📦 *Архив планов* (${plans.length}):`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(rows),
  });
}

function register(bot) {
  // /plans
  bot.command('plans', (ctx) => {
    const userId = getUser(ctx);
    const plans = getPlansWithProgress(userId);
    ctx.reply(`📋 *Планы* (${plans.length}):`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buildPlansKeyboard(plans)),
    });
  });

  // Просмотр плана
  bot.action(/^pv_(\d+)$/, async (ctx) => {
    const planId = Number(ctx.match[1]);
    const plan = getPlanById(planId);
    if (!plan) return ctx.answerCbQuery('План не найден.');
    const tasks = getTasksByPlan(planId);
    await ctx.answerCbQuery();
    await safeDelete(ctx);
    const archiveBtn = plan.status === 'archived'
      ? Markup.button.callback('♻️ Восстановить', `plan_restore_${planId}`)
      : Markup.button.callback('🗃 Архив', `plan_archive_${planId}`);
    await ctx.reply(formatPlanDetail(plan, tasks), {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📋 Задачи', `plan_tasks_${planId}`)],
        [Markup.button.callback('✏️ Изменить', `plan_edit_${planId}`), archiveBtn],
        [Markup.button.callback('🗑 Удалить', `plan_delete_${planId}`), Markup.button.callback('◀️ К планам', 'back_to_plans')],
      ]),
    });
  });

  // Задачи плана
  bot.action(/^plan_tasks_(\d+)$/, async (ctx) => {
    const planId = Number(ctx.match[1]);
    const plan = getPlanById(planId);
    if (!plan) return ctx.answerCbQuery('План не найден.');
    const tasks = getTasksByPlan(planId);
    await ctx.answerCbQuery();
    await renderPlanTaskList(ctx, plan, tasks, true);
  });

  // Создание плана через кнопку
  bot.action('plan_new', async (ctx) => {
    const userId = getUser(ctx);
    pendingTasks.set(userId, { ...(pendingTasks.get(userId) ?? {}), creatingPlan: true });
    await ctx.answerCbQuery();
    await ctx.reply('Введи название нового плана:', Markup.inlineKeyboard([
      [Markup.button.callback('Отмена', 'plan_cancel')],
    ]));
  });

  bot.action('plan_cancel', async (ctx) => {
    const userId = getUser(ctx);
    const state = pendingTasks.get(userId) ?? {};
    delete state.creatingPlan;
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await safeDelete(ctx);
  });

  bot.action('back_to_plans', async (ctx) => {
    const userId = getUser(ctx);
    await ctx.answerCbQuery();
    await safeDelete(ctx);
    await replyWithPlansList(ctx, userId);
  });

  // Архивирование
  bot.action(/^plan_archive_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const planId = Number(ctx.match[1]);
    const plan = getPlanById(planId);
    archivePlan(planId);
    if (notionPlansEnabled(userId) && plan?.notion_page_id) {
      archiveNotionPage(plan.notion_page_id).catch(e => { console.error('Notion sync error:', e.message); logSyncError(userId, `Архив плана "${plan.title}": ${e.message}`); });
    }
    await ctx.answerCbQuery('🗃 Архивировано');
    await safeDelete(ctx);
    await replyWithPlansList(ctx, userId);
  });

  // Архив планов
  bot.action('plans_archive', async (ctx) => {
    const userId = getUser(ctx);
    await ctx.answerCbQuery();
    await safeDelete(ctx);
    await replyWithArchive(ctx, userId);
  });

  bot.action(/^plan_restore_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const plan = getPlanById(Number(ctx.match[1]));
    restorePlan(Number(ctx.match[1]));
    if (notionPlansEnabled(userId) && plan?.notion_page_id) {
      unarchiveNotionPage(plan.notion_page_id).catch(e => { console.error('Notion sync error:', e.message); logSyncError(userId, `Восстановление плана "${plan?.title}": ${e.message}`); });
    }
    await ctx.answerCbQuery(`♻️ "${plan?.title}" восстановлен`);
    await safeDelete(ctx);
    await replyWithArchive(ctx, userId);
  });

  bot.action(/^parc_del_(\d+)$/, async (ctx) => {
    const planId = Number(ctx.match[1]);
    const plan = getPlanById(planId);
    await ctx.answerCbQuery();
    await safeEdit(ctx, `🗑 Удалить *${plan.title}*?`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('Только план', `parc_del_only_${planId}`), Markup.button.callback('С задачами', `parc_del_tasks_${planId}`)],
        [Markup.button.callback('◀️ Отмена', 'plans_archive')],
      ]),
    });
  });

  bot.action(/^parc_del_only_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const planId = Number(ctx.match[1]);
    const plan = getPlanById(planId);
    deletePlan(planId, false);
    if (notionPlansEnabled(userId) && plan?.notion_page_id) {
      archiveNotionPage(plan.notion_page_id).catch(e => { console.error('Notion sync error:', e.message); logSyncError(userId, `Удаление плана "${plan.title}": ${e.message}`); });
    }
    await ctx.answerCbQuery('🗑 Удалено');
    await safeDelete(ctx);
    await replyWithArchive(ctx, userId);
  });

  bot.action(/^parc_del_tasks_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const planId = Number(ctx.match[1]);
    const plan = getPlanById(planId);
    const tasks = getTasksByPlan(planId);
    deletePlan(planId, true);
    if (notionPlansEnabled(userId) && plan?.notion_page_id) {
      archiveNotionPage(plan.notion_page_id).catch(e => { console.error('Notion sync error:', e.message); logSyncError(userId, `Удаление плана "${plan.title}": ${e.message}`); });
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

  // Редактирование плана
  bot.action(/^plan_edit_(\d+)$/, async (ctx) => {
    const planId = Number(ctx.match[1]);
    const plan = getPlanById(planId);
    await ctx.answerCbQuery();
    await safeEdit(ctx, `✏️ *${plan.title}*\n\nЧто изменить?`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📝 Название', `plan_edit_title_${planId}`), Markup.button.callback('📄 Описание', `plan_edit_desc_${planId}`)],
        [Markup.button.callback('◀️ Назад', `pv_${planId}`)],
      ]),
    });
  });

  bot.action(/^plan_edit_(title|desc)_(\d+)$/, async (ctx) => {
    const field  = ctx.match[1];
    const planId = Number(ctx.match[2]);
    const userId = getUser(ctx);
    const plan   = getPlanById(planId);
    const labels = { title: 'Название', desc: 'Описание' };
    const dbField  = field === 'desc' ? 'description' : 'title';
    const current  = plan[dbField];
    const state    = pendingTasks.get(userId) ?? {};
    state.editingPlan = { id: planId, field: dbField };
    pendingTasks.set(userId, state);
    const currentLine = current ? `\nТекущее: \`${current}\`` : '';
    await ctx.answerCbQuery();
    await safeEdit(ctx, `✏️ *${labels[field]}*${currentLine}\n\nОтправь новое значение:`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', `plan_edit_${planId}`)]]),
    });
  });

  bot.action(/^plan_delete_(\d+)$/, async (ctx) => {
    const planId = Number(ctx.match[1]);
    const plan   = getPlanById(planId);
    await ctx.answerCbQuery();
    await safeEdit(ctx, `🗑 Удалить план *${plan.title}*?`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('Только план', `plan_del_only_${planId}`), Markup.button.callback('С задачами', `plan_del_tasks_${planId}`)],
        [Markup.button.callback('◀️ Отмена', `pv_${planId}`)],
      ]),
    });
  });

  bot.action(/^plan_del_only_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const planId = Number(ctx.match[1]);
    const plan   = getPlanById(planId);
    deletePlan(planId, false);
    if (notionPlansEnabled(userId) && plan?.notion_page_id) {
      archiveNotionPage(plan.notion_page_id).catch(e => { console.error('Notion sync error:', e.message); logSyncError(userId, `Удаление плана "${plan.title}": ${e.message}`); });
    }
    await ctx.answerCbQuery('🗑 Удалено');
    await safeDelete(ctx);
    await replyWithPlansList(ctx, userId);
  });

  bot.action(/^plan_del_tasks_(\d+)$/, async (ctx) => {
    const userId = getUser(ctx);
    const planId = Number(ctx.match[1]);
    const plan   = getPlanById(planId);
    const tasks  = getTasksByPlan(planId);
    deletePlan(planId, true);
    if (notionPlansEnabled(userId) && plan?.notion_page_id) {
      archiveNotionPage(plan.notion_page_id).catch(e => { console.error('Notion sync error:', e.message); logSyncError(userId, `Удаление плана "${plan.title}": ${e.message}`); });
    }
    if (notionTasksEnabled(userId)) {
      for (const t of tasks) {
        if (t.notion_page_id) updateTaskStatus(t.notion_page_id, 'deleted').catch(() => {});
      }
    }
    await ctx.answerCbQuery('🗑 Удалено вместе с задачами');
    await safeDelete(ctx);
    await replyWithPlansList(ctx, userId);
  });

  // Создание плана из AI-предложения
  bot.action('plan_confirm_create', async (ctx) => {
    const userId = getUser(ctx);
    if (!acquireProcessing(userId)) return ctx.answerCbQuery('⏳ Уже обрабатывается...');
    const state  = pendingTasks.get(userId);
    if (!state?.planData) { releaseProcessing(userId); return ctx.answerCbQuery('Сессия устарела.'); }
    const { planData } = state;

    await ctx.answerCbQuery();
    await safeEdit(ctx, '⏳ Создаю план и задачи...');

    try {
      const { createTask, updateTask } = require('../taskService');
      const { createSubtasks } = require('../subtaskService');
      const plan = createPlan(userId, { title: planData.title, description: planData.description });

      // Сначала создаём план в Notion, ждём page_id для привязки задач
      let planNotionPageId = null;
      if (notionPlansEnabled(userId)) {
        planNotionPageId = await pushPlan(plan);
        if (planNotionPageId) updatePlan(plan.id, { notion_page_id: planNotionPageId });
      }

      for (const t of planData.tasks) {
        const task = createTask(userId, {
          title:    t.title,
          category: t.category ?? null,
          priority: t.priority ?? null,
          plannedFor: t.plannedFor ?? null,
          plan_id:  plan.id,
        });
        if (t.subtasks?.length) createSubtasks(task.id, t.subtasks);

        // Sync задачи в Notion (plan_notion_page_id уже сохранён в tasks через JOIN)
        if (notionTasksEnabled(userId)) {
          const taskWithPlan = { ...task, plan_notion_page_id: planNotionPageId };
          pushTask(taskWithPlan)
            .then(notionPageId => { if (notionPageId) updateTask(task.id, { notion_page_id: notionPageId }); })
            .catch(e => console.error('Notion task sync error:', e.message));
        }
      }
      pendingTasks.delete(userId);
      await safeEdit(ctx, `✅ Создан план *${plan.title}* с ${planData.tasks.length} задачами!`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('📋 Открыть план', `pv_${plan.id}`)]]),
      });
    } catch (e) {
      console.error(e);
      await safeEdit(ctx, '❌ Ошибка при создании плана.');
    } finally {
      releaseProcessing(userId);
    }
  });

  // Уточнение голосовой команды — выбор плана
  bot.action(/^va_plan_(\d+)$/, async (ctx) => {
    const planId = Number(ctx.match[1]);
    const userId = getUser(ctx);
    const state  = pendingTasks.get(userId);
    if (!state?.voicePlanAction) return ctx.answerCbQuery('Сессия устарела.');
    const plan = getPlanById(planId);
    if (!plan) return ctx.answerCbQuery('План не найден.');
    const action = state.voicePlanAction;
    delete state.voicePlanAction;
    pendingTasks.set(userId, state);
    await ctx.answerCbQuery();
    await safeDelete(ctx);
    const { executePlanAction } = require('./intent');
    await executePlanAction(ctx, userId, plan, action);
  });
}

module.exports = { register, syncNewPlanToNotion, replyWithPlansList };
