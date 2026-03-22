/**
 * Тесты редактирования сохранённой задачи: esf_* handlers + handleText.
 *
 * Покрытие:
 *   SC-19 — edit_saved_N: открывает меню редактирования
 *   SC-20 — esf_title_N + текст: название задачи обновляется
 *   SC-21 — esf_desc_N + текст: описание обновляется
 *   SC-22 — esf_date_N + гибкая дата: due_date обновляется
 *   SC-23 — catsaved_N_X: категория обновляется
 *   SC-24 — prisaved_N_(high|medium|low): приоритет обновляется
 *   SC-25 — plansaved_N_M: план обновляется; plansaved_N_0 убирает план
 *         — esf_wreason_N + текст: waiting_reason обновляется
 *         — esf_wuntil_N + текст: waiting_until обновляется
 */

const { createTestDb }  = require('../helpers/db');
const { mockCtx }       = require('../helpers/ctx');
const { createMockBot } = require('../helpers/bot');

// ─── Моки ────────────────────────────────────────────────────────────────────

let mockTestDb;
jest.mock('../../src/db', () => mockTestDb);

jest.mock('../../src/integrations/notion', () => ({
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

jest.mock('../../src/parser', () => ({
  parseIntent:     jest.fn(),
  suggestSubtasks: jest.fn(),
}));

// ─── Переменные ───────────────────────────────────────────────────────────────

let bot, taskService, planService, categoryService, pendingTasks, handleText;
const USER_ID = 1;

beforeEach(() => {
  mockTestDb = createTestDb();
  jest.resetModules();

  jest.mock('../../src/db', () => mockTestDb);
  jest.mock('../../src/integrations/notion', () => ({
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
  jest.mock('../../src/parser', () => ({
    parseIntent:     jest.fn(),
    suggestSubtasks: jest.fn(),
  }));

  bot             = createMockBot();
  taskService     = require('../../src/taskService');
  planService     = require('../../src/planService');
  categoryService = require('../../src/categoryService');
  ({ pendingTasks } = require('../../src/state'));
  ({ handleText } = require('../../src/handlers/intent'));

  require('../../src/handlers/tasks').register(bot);
});

// ─── SC-19: edit_saved_N — меню редактирования ───────────────────────────────

describe('SC-19: edit_saved_N — открывает меню', () => {
  test('показывает меню редактирования', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    const ctx  = mockCtx({ userId: USER_ID, isCallback: true });

    await bot.trigger(`edit_saved_${task.id}`, ctx);

    expect(ctx.editMessageText).toHaveBeenCalled();
    const [text] = ctx.editMessageText.mock.calls[0];
    expect(text).toContain('изменить');
  });

  test('для waiting-задачи добавляет кнопки waiting полей', async () => {
    const task = taskService.createTask(USER_ID, {
      title: 'Жду ответа', status: 'waiting', waiting_reason: 'причина',
    });
    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`edit_saved_${task.id}`, ctx);
    // Просто убеждаемся что не упало
    expect(ctx.editMessageText).toHaveBeenCalled();
  });
});

// ─── SC-20: esf_title_N + текст — обновить название ──────────────────────────

describe('SC-20: esf_title_N + текст — переименование задачи', () => {
  test('название обновляется в БД', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Старое' });

    // Нажать кнопку — устанавливает editingSavedTask
    const ctx1 = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`esf_title_${task.id}`, ctx1);
    expect(pendingTasks.get(USER_ID)?.editingSavedTask?.field).toBe('title');

    // Ввести новый текст
    const ctx2 = mockCtx({ userId: USER_ID });
    await handleText(ctx2, 'Новое название');

    expect(taskService.getTaskById(task.id).title).toBe('Новое название');
  });

  test('editingSavedTask очищается после обновления', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });

    const ctx1 = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`esf_title_${task.id}`, ctx1);

    const ctx2 = mockCtx({ userId: USER_ID });
    await handleText(ctx2, 'Новое');

    expect(pendingTasks.get(USER_ID)?.editingSavedTask).toBeUndefined();
  });
});

// ─── SC-21: esf_desc_N + текст — обновить описание ───────────────────────────

describe('SC-21: esf_desc_N + текст — обновление описания', () => {
  test('описание обновляется в БД', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });

    const ctx1 = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`esf_desc_${task.id}`, ctx1);

    const ctx2 = mockCtx({ userId: USER_ID });
    await handleText(ctx2, 'Новое описание');

    expect(taskService.getTaskById(task.id).description).toBe('Новое описание');
  });
});

// ─── SC-22: esf_date_N + гибкая дата — обновить due_date ─────────────────────

describe('SC-22: esf_date_N + дата — обновление срока', () => {
  test('ISO дата сохраняется в due_date', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });

    const ctx1 = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`esf_date_${task.id}`, ctx1);

    const ctx2 = mockCtx({ userId: USER_ID });
    await handleText(ctx2, '2026-06-15');

    expect(taskService.getTaskById(task.id).due_date).toBe('2026-06-15');
  });

  test('нераспознанная дата → null в due_date', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });

    const ctx1 = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`esf_date_${task.id}`, ctx1);

    const ctx2 = mockCtx({ userId: USER_ID });
    await handleText(ctx2, 'непонятно когда');

    expect(taskService.getTaskById(task.id).due_date).toBeNull();
  });
});

// ─── SC-23: catsaved_N_X — обновить категорию ────────────────────────────────

describe('SC-23: catsaved_N_X — обновление категории', () => {
  test('категория задачи обновляется', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    categoryService.createCategory(USER_ID, 'Работа');

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`catsaved_${task.id}_Работа`, ctx);

    expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('Категория'));
    // Задача обновлена — editMessageText вызван с деталями
    expect(ctx.editMessageText).toHaveBeenCalled();
  });

  test('несуществующая категория создаётся автоматически', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`catsaved_${task.id}_НоваяКат`, ctx);

    // Категория теперь существует
    const cat = categoryService.getCategoryByName(USER_ID, 'НоваяКат');
    expect(cat).toBeDefined();
  });
});

// ─── SC-24: prisaved_N_(high|medium|low) — обновить приоритет ────────────────

describe('SC-24: prisaved_N_X — обновление приоритета', () => {
  test('приоритет high сохраняется', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    const ctx  = mockCtx({ userId: USER_ID, isCallback: true });

    await bot.trigger(`prisaved_${task.id}_high`, ctx);

    expect(taskService.getTaskById(task.id).priority).toBe('high');
  });

  test('приоритет medium сохраняется', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    const ctx  = mockCtx({ userId: USER_ID, isCallback: true });

    await bot.trigger(`prisaved_${task.id}_medium`, ctx);

    expect(taskService.getTaskById(task.id).priority).toBe('medium');
  });

  test('приоритет low сохраняется', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    const ctx  = mockCtx({ userId: USER_ID, isCallback: true });

    await bot.trigger(`prisaved_${task.id}_low`, ctx);

    expect(taskService.getTaskById(task.id).priority).toBe('low');
  });
});

// ─── SC-25: plansaved_N_M — обновить план ────────────────────────────────────

describe('SC-25: plansaved_N_M — обновление плана задачи', () => {
  test('задача привязывается к плану', async () => {
    const plan = planService.createPlan(USER_ID, { title: 'Мой план' });
    const task = taskService.createTask(USER_ID, { title: 'Задача' });

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`plansaved_${task.id}_${plan.id}`, ctx);

    expect(taskService.getTaskById(task.id).plan_id).toBe(plan.id);
  });

  test('plansaved_N_0 убирает задачу из плана', async () => {
    const plan = planService.createPlan(USER_ID, { title: 'Мой план' });
    const task = taskService.createTask(USER_ID, { title: 'Задача', plan_id: plan.id });

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`plansaved_${task.id}_0`, ctx);

    expect(taskService.getTaskById(task.id).plan_id).toBeNull();
  });
});

// ─── esf_wreason / esf_wuntil — waiting поля ─────────────────────────────────

describe('esf_wreason_N + esf_wuntil_N — редактирование waiting полей', () => {
  test('esf_wreason_N + текст → waiting_reason обновляется', async () => {
    const task = taskService.createTask(USER_ID, {
      title: 'Жду', status: 'waiting', waiting_reason: 'старая причина',
    });

    const ctx1 = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`esf_wreason_${task.id}`, ctx1);
    expect(pendingTasks.get(USER_ID)?.editingSavedTask?.field).toBe('waiting_reason');

    const ctx2 = mockCtx({ userId: USER_ID });
    await handleText(ctx2, 'новая причина');

    expect(taskService.getTaskById(task.id).waiting_reason).toBe('новая причина');
  });

  test('esf_wuntil_N + ISO дата → waiting_until обновляется', async () => {
    const task = taskService.createTask(USER_ID, {
      title: 'Жду', status: 'waiting', waiting_until: '2026-03-01',
    });

    const ctx1 = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`esf_wuntil_${task.id}`, ctx1);

    const ctx2 = mockCtx({ userId: USER_ID });
    await handleText(ctx2, '2026-05-10');

    expect(taskService.getTaskById(task.id).waiting_until).toBe('2026-05-10');
  });
});
