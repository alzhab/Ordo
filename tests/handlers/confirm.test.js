/**
 * Тесты button-handlers из tasks.js register().
 *
 * Покрытие:
 *   SC-01 (финал) — 'confirm': задача сохраняется в БД, показывается success
 *   SC-03 (финал) — 'confirm': подзадачи сохраняются в БД
 *   SC-05 (финал) — 'confirm': waiting-задача нормализует поля перед сохранением
 *   SC-26         — ts_in_progress_N: статус меняется на in_progress
 *   SC-27         — ts_done_N: статус меняется на done
 *   SC-28         — ts_in_progress_N на waiting-задаче: clearing waiting полей
 *   SC-34 (финал) — ts_confirm_delete_N: задача soft-deleted
 *   SC-06         — batch_do: задача создаётся, batchIndex растёт
 *   SC-07         — batch_skip: задача НЕ создаётся, batchIndex растёт
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

// ─── Переменные ───────────────────────────────────────────────────────────────

let bot, taskService, subtaskService, pendingTasks;
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

  bot            = createMockBot();
  taskService    = require('../../src/taskService');
  subtaskService = require('../../src/subtaskService');
  ({ pendingTasks } = require('../../src/state'));

  require('../../src/handlers/tasks').register(bot);
});

// ─── SC-01 (финал): confirm → задача сохраняется ─────────────────────────────

describe('SC-01 (финал): confirm — создание задачи', () => {
  test('задача сохраняется в БД', async () => {
    pendingTasks.set(USER_ID, {
      task: { title: 'Купить молоко', category: 'Общее', status: null },
      editingField: null,
    });

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('confirm', ctx);

    const tasks = taskService.getTasks(USER_ID);
    expect(tasks.length).toBe(1);
    expect(tasks[0].title).toBe('Купить молоко');
    expect(tasks[0].status).toBe('not_started');
  });

  test('state очищается после создания', async () => {
    pendingTasks.set(USER_ID, {
      task: { title: 'Купить молоко', category: 'Общее', status: null },
      editingField: null,
    });

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('confirm', ctx);

    expect(pendingTasks.get(USER_ID)).toBeUndefined();
  });

  test('показывает сообщение об успехе', async () => {
    pendingTasks.set(USER_ID, {
      task: { title: 'Купить молоко', category: 'Общее', status: null },
      editingField: null,
    });

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('confirm', ctx);

    const successCall = ctx.editMessageText.mock.calls.find(
      ([text]) => typeof text === 'string' && text.includes('Купить молоко') && text.includes('✅')
    );
    expect(successCall).toBeDefined();
  });

  test('при пустом state отвечает об устаревшей сессии', async () => {
    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('confirm', ctx);

    expect(ctx.answerCbQuery).toHaveBeenCalledWith(
      expect.stringContaining('устарела')
    );
  });
});

// ─── SC-03 (финал): confirm — подзадачи сохраняются ──────────────────────────

describe('SC-03 (финал): confirm — задача с подзадачами', () => {
  test('подзадачи сохраняются в БД', async () => {
    pendingTasks.set(USER_ID, {
      task: {
        title: 'Подготовить презентацию', category: 'Работа', status: null,
        subtasks: ['Сделать слайды', 'Собрать данные', 'Согласовать'],
      },
      editingField: null,
    });

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('confirm', ctx);

    const tasks = taskService.getTasks(USER_ID);
    expect(tasks.length).toBe(1);
    const subtasks = subtaskService.getSubtasks(tasks[0].id);
    expect(subtasks.length).toBe(3);
    expect(subtasks[0].title).toBe('Сделать слайды');
  });
});

// ─── SC-05 (финал): confirm — waiting-задача ──────────────────────────────────

describe('SC-05 (финал): confirm — задача с waiting статусом', () => {
  test('задача сохраняется со статусом waiting и полями ожидания', async () => {
    pendingTasks.set(USER_ID, {
      task: {
        title: 'Записался к врачу', category: 'Здоровье',
        status: 'waiting', waiting_reason: 'приём у врача', waiting_until: '2026-04-01',
      },
      editingField: null,
    });

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('confirm', ctx);

    const tasks = taskService.getTasks(USER_ID, { status: 'waiting' });
    expect(tasks.length).toBe(1);
    expect(tasks[0].status).toBe('waiting');
    expect(tasks[0].waiting_reason).toBe('приём у врача');
    expect(tasks[0].waiting_until).toBe('2026-04-01');
  });

  test('normalizeWaiting извлекает дату из причины если waiting_until=null', async () => {
    pendingTasks.set(USER_ID, {
      task: {
        title: 'Заказ на WB', category: 'Общее',
        status: 'waiting',
        waiting_reason: 'заказ на WB придёт 7 апреля',
        waiting_until: null,
      },
      editingField: null,
    });

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('confirm', ctx);

    const tasks = taskService.getTasks(USER_ID, { status: 'waiting' });
    expect(tasks[0].waiting_until).not.toBeNull(); // дата извлечена из причины
  });
});

// ─── SC-26/SC-27: ts_* кнопки — смена статуса ────────────────────────────────

describe('SC-26/SC-27: ts_* — смена статуса через кнопку', () => {
  let task;

  beforeEach(() => {
    task = taskService.createTask(USER_ID, { title: 'Тестовая задача' });
  });

  test('SC-26: ts_in_progress_N → статус in_progress', async () => {
    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`ts_in_progress_${task.id}`, ctx);

    expect(taskService.getTaskById(task.id).status).toBe('in_progress');
    expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('В работу'));
  });

  test('SC-27: ts_done_N → статус done', async () => {
    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`ts_done_${task.id}`, ctx);

    expect(taskService.getTaskById(task.id).status).toBe('done');
  });

  test('ts_not_started_N → статус not_started', async () => {
    taskService.updateTask(task.id, { status: 'in_progress' });
    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`ts_not_started_${task.id}`, ctx);

    expect(taskService.getTaskById(task.id).status).toBe('not_started');
  });
});

// ─── SC-28: выход из waiting через кнопку очищает waiting поля ───────────────

describe('SC-28: ts_in_progress_N на waiting-задаче', () => {
  test('clearing: waiting_reason и waiting_until обнуляются', async () => {
    const task = taskService.createTask(USER_ID, {
      title: 'Жду посылку', status: 'waiting',
      waiting_reason: 'посылка на почте', waiting_until: '2026-03-25',
    });

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`ts_in_progress_${task.id}`, ctx);

    const updated = taskService.getTaskById(task.id);
    expect(updated.status).toBe('in_progress');
    expect(updated.waiting_reason).toBeNull();
    expect(updated.waiting_until).toBeNull();
  });

  test('ts_not_started_N на waiting-задаче тоже очищает поля', async () => {
    const task = taskService.createTask(USER_ID, {
      title: 'Жду ответа', status: 'waiting',
      waiting_reason: 'жду ответа', waiting_until: null,
    });

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`ts_not_started_${task.id}`, ctx);

    const updated = taskService.getTaskById(task.id);
    expect(updated.status).toBe('not_started');
    expect(updated.waiting_reason).toBeNull();
  });
});

// ─── SC-34 (финал): ts_confirm_delete_N → задача soft-deleted ────────────────

describe('SC-34 (финал): ts_confirm_delete — подтверждение удаления', () => {
  test('задача переходит в статус deleted', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Удалить меня' });
    const ctx  = mockCtx({ userId: USER_ID, isCallback: true });

    await bot.trigger(`ts_confirm_delete_${task.id}`, ctx);

    expect(taskService.getTaskById(task.id).status).toBe('deleted');
  });

  test('задача исчезает из обычного списка после удаления', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Удалить меня' });
    const ctx  = mockCtx({ userId: USER_ID, isCallback: true });

    await bot.trigger(`ts_confirm_delete_${task.id}`, ctx);

    expect(taskService.getTasks(USER_ID).length).toBe(0);
  });
});

// ─── SC-06/SC-07: batch_do / batch_skip — слайдер ────────────────────────────

describe('SC-06/SC-07: batch_do / batch_skip', () => {
  const batchTasks = [
    { title: 'Купить молоко', category: 'Общее', status: null },
    { title: 'Позвонить врачу', category: 'Общее', status: null },
    { title: 'Записаться на стрижку', category: 'Общее', status: null },
  ];

  test('SC-06: batch_do создаёт задачу и переходит к следующей', async () => {
    pendingTasks.set(USER_ID, { batchTasks, batchIndex: 0, batchCreated: [] });

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('batch_do', ctx);

    // Задача создана
    const tasks = taskService.getTasks(USER_ID);
    expect(tasks.length).toBe(1);
    expect(tasks[0].title).toBe('Купить молоко');

    // Индекс вырос
    const state = pendingTasks.get(USER_ID);
    expect(state.batchIndex).toBe(1);
    expect(state.batchCreated.length).toBe(1);
  });

  test('SC-07: batch_skip НЕ создаёт задачу и переходит к следующей', async () => {
    pendingTasks.set(USER_ID, { batchTasks, batchIndex: 0, batchCreated: [] });

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('batch_skip', ctx);

    // Задача НЕ создана
    expect(taskService.getTasks(USER_ID).length).toBe(0);

    // Индекс вырос
    const state = pendingTasks.get(USER_ID);
    expect(state.batchIndex).toBe(1);
    expect(state.batchCreated.length).toBe(0);
  });

  test('batch_do на последней задаче очищает state', async () => {
    pendingTasks.set(USER_ID, {
      batchTasks: [{ title: 'Последняя', category: 'Общее', status: null }],
      batchIndex: 0,
      batchCreated: [],
    });

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('batch_do', ctx);

    // State очищен после завершения слайдера
    expect(pendingTasks.get(USER_ID)).toBeUndefined();
  });

  test('итог слайдера показывает количество созданных задач', async () => {
    pendingTasks.set(USER_ID, {
      batchTasks: [{ title: 'Задача 1', category: 'Общее', status: null }],
      batchIndex: 0,
      batchCreated: [],
    });

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('batch_do', ctx);

    const successCall = ctx.editMessageText.mock.calls.find(
      ([text]) => typeof text === 'string' && text.includes('Создано') && text.includes('1')
    );
    expect(successCall).toBeDefined();
  });
});
