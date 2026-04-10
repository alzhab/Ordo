/**
 * Тесты фильтров из tasks.js register().
 *
 * Покрытие:
 *   SC-09 — /tasks: показывает список задач
 *   SC-10 — tf_status_in_progress: фильтр по статусу in_progress
 *   SC-11 — tf_status_waiting: фильтр по статусу waiting
 *   SC-12 — tf_set_cat_X: фильтр по категории
 *   SC-13 — tf_clear_cat: сброс фильтра категории
 *   SC-14 — tf_set_plan_N: фильтр по плану
 *   SC-15 — tf_clear_plan: сброс фильтра плана
 *         — tf_status_done / tf_status_not_started / tf_status_all
 *         — tf_clear_status: открывает подменю
 *         — tf_archived / tf_clear_archived
 *         — tf_back: возврат к списку задач
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

let bot, taskService, planService, taskFilters, getFilter;
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
  taskService = require('../../src/application/tasks');
  planService = require('../../src/application/goals');
  ({ taskFilters, getFilter } = require('../../src/shared/state'));

  require('../../src/delivery/telegram/handlers/tasks').register(bot);
});

// ─── SC-09: /tasks ────────────────────────────────────────────────────────────

describe('SC-09: /tasks — команда', () => {
  test('отправляет список задач', async () => {
    taskService.createTask(USER_ID, { title: 'Задача 1', status: 'in_progress' });
    const ctx = mockCtx({ userId: USER_ID });
    await bot.triggerCommand('tasks', ctx);

    expect(ctx.reply).toHaveBeenCalled();
  });

  test('при отсутствии задач всё равно отвечает', async () => {
    const ctx = mockCtx({ userId: USER_ID });
    await bot.triggerCommand('tasks', ctx);
    expect(ctx.reply).toHaveBeenCalled();
  });
});

// ─── SC-10/SC-11: tf_status_* — фильтр по статусу ────────────────────────────

describe('SC-10/SC-11: tf_status_* — фильтр по статусу', () => {
  test('SC-10: tf_status_in_progress устанавливает filter.status = in_progress', async () => {
    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('tf_status_in_progress', ctx);

    expect(getFilter(USER_ID).status).toBe('in_progress');
  });

  test('SC-11: tf_status_waiting устанавливает filter.status = waiting', async () => {
    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('tf_status_waiting', ctx);

    expect(getFilter(USER_ID).status).toBe('waiting');
  });

  test('tf_status_done устанавливает filter.status = done', async () => {
    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('tf_status_done', ctx);

    expect(getFilter(USER_ID).status).toBe('done');
  });

  test('tf_status_not_started устанавливает filter.status = not_started', async () => {
    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('tf_status_not_started', ctx);

    expect(getFilter(USER_ID).status).toBe('not_started');
  });

  test('tf_status_all удаляет filter.status', async () => {
    // Сначала установим статус
    getFilter(USER_ID).status = 'done';
    taskFilters.set(USER_ID, getFilter(USER_ID));

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('tf_status_all', ctx);

    expect(getFilter(USER_ID).status).toBeUndefined();
  });
});

// ─── tf_status — открывает подменю ────────────────────────────────────────────

describe('tf_status — подменю статуса', () => {
  test('вызывает editMessageText с кнопками статусов', async () => {
    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('tf_status', ctx);

    const calls = ctx.editMessageText.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [text] = calls[0];
    expect(text).toContain('статус');
  });

  test('tf_clear_status тоже открывает подменю', async () => {
    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('tf_clear_status', ctx);
    expect(ctx.editMessageText).toHaveBeenCalled();
  });
});

// ─── SC-12/SC-13: tf_set_cat / tf_clear_cat ──────────────────────────────────

describe('SC-12/SC-13: категориальный фильтр', () => {
  test('SC-12: tf_set_cat_X устанавливает filter.category', async () => {
    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('tf_set_cat_Работа', ctx);

    expect(getFilter(USER_ID).category).toBe('Работа');
  });

  test('SC-13: tf_clear_cat удаляет filter.category', async () => {
    // Сначала установим
    const filter = getFilter(USER_ID);
    filter.category = 'Работа';
    taskFilters.set(USER_ID, filter);

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('tf_clear_cat', ctx);

    expect(getFilter(USER_ID).category).toBeUndefined();
  });
});

// ─── SC-14/SC-15: tf_set_plan / tf_clear_plan ────────────────────────────────

describe('SC-14/SC-15: план-фильтр', () => {
  let plan;

  beforeEach(() => {
    plan = planService.createGoal(USER_ID, { title: 'Мой план' });
  });

  test('SC-14: tf_set_plan_N устанавливает filter.planId', async () => {
    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`tf_set_plan_${plan.id}`, ctx);

    const filter = getFilter(USER_ID);
    expect(filter.planId).toBe(plan.id);
    expect(filter.planTitle).toBe('Мой план');
  });

  test('SC-15: tf_clear_plan удаляет planId и planTitle', async () => {
    // Сначала установим
    const filter = getFilter(USER_ID);
    filter.planId    = plan.id;
    filter.planTitle = 'Мой план';
    taskFilters.set(USER_ID, filter);

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('tf_clear_plan', ctx);

    const updated = getFilter(USER_ID);
    expect(updated.planId).toBeUndefined();
    expect(updated.planTitle).toBeUndefined();
  });
});

// ─── tf_archived / tf_clear_archived ─────────────────────────────────────────

describe('tf_archived / tf_clear_archived — архив задач', () => {
  test('tf_archived устанавливает filter.includeArchived = true', async () => {
    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('tf_archived', ctx);

    expect(getFilter(USER_ID).includeArchived).toBe(true);
  });

  test('tf_clear_archived удаляет filter.includeArchived', async () => {
    const filter = getFilter(USER_ID);
    filter.includeArchived = true;
    taskFilters.set(USER_ID, filter);

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('tf_clear_archived', ctx);

    expect(getFilter(USER_ID).includeArchived).toBeUndefined();
  });
});

// ─── tf_back: возврат к списку ────────────────────────────────────────────────

describe('tf_back — возврат к списку', () => {
  test('вызывает answerCbQuery', async () => {
    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('tf_back', ctx);
    expect(ctx.answerCbQuery).toHaveBeenCalled();
  });
});

// ─── SC-69: фильтр сохраняется между вызовами ────────────────────────────────

describe('SC-69: персистентность фильтра', () => {
  test('установленный фильтр статуса сохраняется в taskFilters', async () => {
    const ctx1 = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('tf_status_done', ctx1);

    // Симулируем новый вызов — фильтр всё ещё in taskFilters
    expect(taskFilters.get(USER_ID).status).toBe('done');
  });

  test('разные пользователи имеют независимые фильтры', async () => {
    const ctx1 = mockCtx({ userId: 1, isCallback: true });
    const ctx2 = mockCtx({ userId: 2, isCallback: true });

    await bot.trigger('tf_status_done', ctx1);
    await bot.trigger('tf_status_waiting', ctx2);

    expect(getFilter(1).status).toBe('done');
    expect(getFilter(2).status).toBe('waiting');
  });
});
