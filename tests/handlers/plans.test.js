/**
 * Тесты handlers из plans.js register().
 *
 * Покрытие:
 *   SC-43 — /plans: показывает список планов
 *   SC-44 — pv_N: открывает карточку плана
 *   SC-45а — plan_archive_N: план переходит в archived
 *   SC-45б — plan_restore_N: план восстанавливается из архива
 *   SC-46 — plan_tasks_N: показывает задачи плана
 *   SC-47 — plan_new: создаёт pending-состояние для ввода названия
 *   SC-48 — parc_del_only_N: удаляет только план (задачи остаются)
 *   SC-49 — parc_del_tasks_N: удаляет план вместе с задачами
 */

const { createTestDb }  = require('../helpers/db');
const { mockCtx }       = require('../helpers/ctx');
const { createMockBot } = require('../helpers/bot');

// ─── Моки ────────────────────────────────────────────────────────────────────

let mockTestDb;
jest.mock('../../src/infrastructure/db/connection', () => mockTestDb);
jest.mock('../../src/infrastructure/db/connection', () => mockTestDb);

jest.mock('../../src/infrastructure/integrations/notion', () => ({
  isConfigured:            () => false,
  isPlansConfigured:       () => false,
  pushTask:                jest.fn().mockResolvedValue('notion-id'),
  updateTaskFields:        jest.fn().mockResolvedValue({}),
  updateTaskStatus:        jest.fn().mockResolvedValue({}),
  syncSubtasksToNotion:    jest.fn().mockResolvedValue([]),
  appendSubtaskToNotion:   jest.fn().mockResolvedValue('block-id'),
  updateSubtaskBlockTitle: jest.fn().mockResolvedValue({}),
  pushPlan:                jest.fn().mockResolvedValue('notion-plan-id'),
  archiveNotionPage:       jest.fn().mockResolvedValue({}),
  unarchiveNotionPage:     jest.fn().mockResolvedValue({}),
  updatePlanFields:        jest.fn().mockResolvedValue({}),
}));

// ─── Переменные ───────────────────────────────────────────────────────────────

let bot, planService, taskService, pendingTasks;
const USER_ID = 1;

beforeEach(() => {
  mockTestDb = createTestDb();
  jest.resetModules();

  jest.mock('../../src/infrastructure/db/connection', () => mockTestDb);
jest.mock('../../src/infrastructure/db/connection', () => mockTestDb);
  jest.mock('../../src/infrastructure/integrations/notion', () => ({
    isConfigured:            () => false,
    isPlansConfigured:       () => false,
    pushTask:                jest.fn().mockResolvedValue('notion-id'),
    updateTaskFields:        jest.fn().mockResolvedValue({}),
    updateTaskStatus:        jest.fn().mockResolvedValue({}),
    syncSubtasksToNotion:    jest.fn().mockResolvedValue([]),
    appendSubtaskToNotion:   jest.fn().mockResolvedValue('block-id'),
    updateSubtaskBlockTitle: jest.fn().mockResolvedValue({}),
    pushPlan:                jest.fn().mockResolvedValue('notion-plan-id'),
    archiveNotionPage:       jest.fn().mockResolvedValue({}),
    unarchiveNotionPage:     jest.fn().mockResolvedValue({}),
    updatePlanFields:        jest.fn().mockResolvedValue({}),
  }));

  bot         = createMockBot();
  planService = require('../../src/application/goals');
  taskService = require('../../src/application/tasks');
  ({ pendingTasks } = require('../../src/shared/state'));

  require('../../src/delivery/telegram/handlers/plans').register(bot);
});

// ─── SC-43: /plans ────────────────────────────────────────────────────────────

describe('SC-43: /plans — команда', () => {
  test('отправляет список планов', async () => {
    planService.createGoal(USER_ID, { title: 'Выучить испанский' });
    const ctx = mockCtx({ userId: USER_ID });
    await bot.triggerCommand('plans', ctx);

    expect(ctx.reply).toHaveBeenCalled();
    const [text] = ctx.reply.mock.calls[0];
    expect(text).toContain('Планы');
  });

  test('при пустом списке всё равно отвечает', async () => {
    const ctx = mockCtx({ userId: USER_ID });
    await bot.triggerCommand('plans', ctx);
    expect(ctx.reply).toHaveBeenCalled();
  });
});

// ─── SC-44: pv_N — просмотр плана ────────────────────────────────────────────

describe('SC-44: pv_N — карточка плана', () => {
  test('открывает карточку плана', async () => {
    const plan = planService.createGoal(USER_ID, { title: 'Научиться рисовать' });
    const ctx  = mockCtx({ userId: USER_ID, isCallback: true });

    await bot.trigger(`pv_${plan.id}`, ctx);

    expect(ctx.reply).toHaveBeenCalled();
    const [text] = ctx.reply.mock.calls[0];
    expect(text).toContain('Научиться рисовать');
  });

  test('отвечает об ошибке при несуществующем плане', async () => {
    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('pv_9999', ctx);
    expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('не найден'));
  });
});

// ─── SC-45а: plan_archive_N ───────────────────────────────────────────────────

describe('SC-45а: plan_archive_N — архивирование', () => {
  test('план переходит в статус archived', async () => {
    const plan = planService.createGoal(USER_ID, { title: 'Архивировать меня' });
    const ctx  = mockCtx({ userId: USER_ID, isCallback: true });

    await bot.trigger(`plan_archive_${plan.id}`, ctx);

    const updated = planService.getGoalById(plan.id);
    expect(updated.status).toBe('archived');
  });

  test('archivePlan вызывает answerCbQuery с подтверждением', async () => {
    const plan = planService.createGoal(USER_ID, { title: 'Тест архив' });
    const ctx  = mockCtx({ userId: USER_ID, isCallback: true });

    await bot.trigger(`plan_archive_${plan.id}`, ctx);

    expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('Архив'));
  });
});

// ─── SC-45б: plan_restore_N ──────────────────────────────────────────────────

describe('SC-45б: plan_restore_N — восстановление', () => {
  test('план восстанавливается из архива', async () => {
    const plan = planService.createGoal(USER_ID, { title: 'Восстановить меня' });
    planService.archiveGoal(plan.id);

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`plan_restore_${plan.id}`, ctx);

    const updated = planService.getGoalById(plan.id);
    expect(updated.status).toBe('active');
  });

  test('answerCbQuery содержит название плана', async () => {
    const plan = planService.createGoal(USER_ID, { title: 'Мой план' });
    planService.archiveGoal(plan.id);

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`plan_restore_${plan.id}`, ctx);

    expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('Мой план'));
  });
});

// ─── SC-46: plan_tasks_N — задачи плана ──────────────────────────────────────

describe('SC-46: plan_tasks_N — задачи плана', () => {
  test('показывает задачи плана', async () => {
    const plan = planService.createGoal(USER_ID, { title: 'Мой план' });
    taskService.createTask(USER_ID, { title: 'Задача плана', plan_id: plan.id });

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`plan_tasks_${plan.id}`, ctx);

    expect(ctx.answerCbQuery).toHaveBeenCalled();
  });

  test('отвечает об ошибке если план не найден', async () => {
    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('plan_tasks_9999', ctx);
    expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('не найден'));
  });
});

// ─── SC-47: plan_new — создание нового плана ─────────────────────────────────

describe('SC-47: plan_new — инициирует создание плана', () => {
  test('устанавливает creatingPlan в pending state', async () => {
    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('plan_new', ctx);

    const state = pendingTasks.get(USER_ID);
    expect(state?.creatingPlan).toBe(true);
  });

  test('просит ввести название плана', async () => {
    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('plan_new', ctx);

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('план'),
      expect.anything(),
    );
  });
});

// ─── SC-48: parc_del_only_N — удаление только плана ─────────────────────────

describe('SC-48: parc_del_only_N — удаление только плана', () => {
  test('план удаляется, задачи остаются', async () => {
    const plan = planService.createGoal(USER_ID, { title: 'Удаляемый план' });
    planService.archiveGoal(plan.id);
    taskService.createTask(USER_ID, { title: 'Задача плана', plan_id: plan.id });

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`parc_del_only_${plan.id}`, ctx);

    expect(planService.getGoalById(plan.id)).toBeFalsy();
    // Задача остаётся в БД
    const tasks = taskService.getTasks(USER_ID);
    expect(tasks.length).toBe(1);
  });
});

// ─── SC-49: parc_del_tasks_N — удаление плана с задачами ─────────────────────

describe('SC-49: parc_del_tasks_N — удаление плана вместе с задачами', () => {
  test('план и задачи удаляются', async () => {
    const plan = planService.createGoal(USER_ID, { title: 'Удаляемый план' });
    planService.archiveGoal(plan.id);
    taskService.createTask(USER_ID, { title: 'Задача 1', plan_id: plan.id });
    taskService.createTask(USER_ID, { title: 'Задача 2', plan_id: plan.id });

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`parc_del_tasks_${plan.id}`, ctx);

    expect(planService.getGoalById(plan.id)).toBeFalsy();
    // Задачи помечены deleted — не видны в обычном getTasks
    expect(taskService.getTasks(USER_ID).length).toBe(0);
  });

  test('answerCbQuery содержит подтверждение удаления', async () => {
    const plan = planService.createGoal(USER_ID, { title: 'Тест' });
    planService.archiveGoal(plan.id);

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`parc_del_tasks_${plan.id}`, ctx);

    expect(ctx.answerCbQuery).toHaveBeenCalledWith(
      expect.stringContaining('Удалено'),
    );
  });
});

// ─── back_to_plans ────────────────────────────────────────────────────────────

describe('back_to_plans — возврат к списку', () => {
  test('отвечает списком планов', async () => {
    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('back_to_plans', ctx);
    expect(ctx.reply).toHaveBeenCalled();
  });
});

// ─── plans_archive — открытие архива ─────────────────────────────────────────

describe('plans_archive — архив планов', () => {
  test('отвечает списком архива', async () => {
    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('plans_archive', ctx);
    expect(ctx.reply).toHaveBeenCalled();
  });

  test('при пустом архиве сообщает об этом', async () => {
    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('plans_archive', ctx);
    const [text] = ctx.reply.mock.calls[0];
    expect(text).toContain('Архив');
  });
});
