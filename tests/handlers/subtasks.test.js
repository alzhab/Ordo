/**
 * Тесты handlers из subtasks.js register()  +  text-ввод шагов из handleText.
 *
 * Покрытие:
 *   SC-53 — steps_N: открывает список шагов
 *   SC-54 — step_toggle_N: шаг отмечается выполненным / снимается
 *   SC-55 — step_add_N + текст: шаг добавляется в БД
 *   SC-56 — step_edit_N + текст: название шага обновляется
 *   SC-57 — step_del_N: шаг удаляется
 *   SC-58 — ai_steps_replace_N: AI-шаги заменяют существующие
 *         — ai_steps_merge_N: AI-шаги добавляются без дубликатов
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
  toggleSubtaskInNotion:   jest.fn().mockResolvedValue({}),
  deleteNotionBlock:       jest.fn().mockResolvedValue({}),
  pushPlan:                jest.fn().mockResolvedValue('notion-plan-id'),
  archiveNotionPage:       jest.fn().mockResolvedValue({}),
  unarchiveNotionPage:     jest.fn().mockResolvedValue({}),
  updatePlanFields:        jest.fn().mockResolvedValue({}),
}));

jest.mock('../../src/infrastructure/ai/parser', () => ({
  parseIntent:      jest.fn(),
  suggestSubtasks:  jest.fn().mockResolvedValue(['Шаг A', 'Шаг B', 'Шаг C']),
}));

// ─── Переменные ───────────────────────────────────────────────────────────────

let bot, taskService, subtaskService, pendingTasks, handleText;
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
    toggleSubtaskInNotion:   jest.fn().mockResolvedValue({}),
    deleteNotionBlock:       jest.fn().mockResolvedValue({}),
    pushPlan:                jest.fn().mockResolvedValue('notion-plan-id'),
    archiveNotionPage:       jest.fn().mockResolvedValue({}),
    unarchiveNotionPage:     jest.fn().mockResolvedValue({}),
    updatePlanFields:        jest.fn().mockResolvedValue({}),
  }));
  jest.mock('../../src/infrastructure/ai/parser', () => ({
    parseIntent:     jest.fn(),
    suggestSubtasks: jest.fn().mockResolvedValue(['Шаг A', 'Шаг B', 'Шаг C']),
  }));

  bot            = createMockBot();
  taskService    = require('../../src/application/tasks');
  subtaskService = require('../../src/application/subtasks');
  ({ pendingTasks } = require('../../src/shared/state'));
  ({ handleText } = require('../../src/delivery/telegram/handlers/intent'));

  require('../../src/delivery/telegram/handlers/tasks').register(bot);
  require('../../src/delivery/telegram/handlers/subtasks').register(bot);
});

// ─── SC-53: steps_N — открыть список шагов ───────────────────────────────────

describe('SC-53: steps_N — список шагов', () => {
  test('показывает список шагов задачи', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    subtaskService.createSubtask(task.id, 'Первый шаг');

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`steps_${task.id}`, ctx);

    expect(ctx.editMessageText).toHaveBeenCalled();
    const [text] = ctx.editMessageText.mock.calls[0];
    expect(text).toContain('Первый шаг');
  });

  test('показывает пустой список если шагов нет', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача без шагов' });
    const ctx  = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`steps_${task.id}`, ctx);
    expect(ctx.editMessageText).toHaveBeenCalled();
  });
});

// ─── SC-54: step_toggle_N ─────────────────────────────────────────────────────

describe('SC-54: step_toggle_N — переключить выполнение шага', () => {
  test('is_done меняется с false на true', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    const sub  = subtaskService.createSubtask(task.id, 'Шаг 1');
    expect(sub.is_done).toBe(0);

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`step_toggle_${sub.id}`, ctx);

    expect(subtaskService.getSubtaskById(sub.id).is_done).toBe(1);
  });

  test('повторный toggle возвращает is_done обратно в false', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    const sub  = subtaskService.createSubtask(task.id, 'Шаг 1');
    subtaskService.toggleSubtask(sub.id); // → done

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`step_toggle_${sub.id}`, ctx);

    expect(subtaskService.getSubtaskById(sub.id).is_done).toBe(0);
  });
});

// ─── SC-55: step_add_N + текст ────────────────────────────────────────────────

describe('SC-55: step_add_N + текстовый ввод — добавить шаг', () => {
  test('шаг добавляется в БД после ввода текста', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });

    // Шаг 1: нажать кнопку — устанавливает addingStep в state
    const ctx1 = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`step_add_${task.id}`, ctx1);

    expect(pendingTasks.get(USER_ID)?.addingStep?.taskId).toBe(task.id);

    // Шаг 2: ввод текста
    const ctx2 = mockCtx({ userId: USER_ID });
    await handleText(ctx2, 'Новый шаг');

    const subtasks = subtaskService.getSubtasks(task.id);
    expect(subtasks.length).toBe(1);
    expect(subtasks[0].title).toBe('Новый шаг');
  });

  test('addingStep очищается из state после добавления', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });

    const ctx1 = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`step_add_${task.id}`, ctx1);

    const ctx2 = mockCtx({ userId: USER_ID });
    await handleText(ctx2, 'Мой шаг');

    expect(pendingTasks.get(USER_ID)?.addingStep).toBeUndefined();
  });
});

// ─── SC-56: step_edit_N + текст ──────────────────────────────────────────────

describe('SC-56: step_edit_N + текстовый ввод — переименовать шаг', () => {
  test('название шага обновляется в БД', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    const sub  = subtaskService.createSubtask(task.id, 'Старое название');

    // Шаг 1: кнопка редактирования
    const ctx1 = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`step_edit_${sub.id}`, ctx1);

    expect(pendingTasks.get(USER_ID)?.editingStep?.subId).toBe(sub.id);

    // Шаг 2: новый текст
    const ctx2 = mockCtx({ userId: USER_ID });
    await handleText(ctx2, 'Новое название');

    expect(subtaskService.getSubtaskById(sub.id).title).toBe('Новое название');
  });

  test('editingStep очищается после редактирования', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    const sub  = subtaskService.createSubtask(task.id, 'Шаг');

    const ctx1 = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`step_edit_${sub.id}`, ctx1);

    const ctx2 = mockCtx({ userId: USER_ID });
    await handleText(ctx2, 'Обновлено');

    expect(pendingTasks.get(USER_ID)?.editingStep).toBeUndefined();
  });
});

// ─── SC-57: step_del_N ────────────────────────────────────────────────────────

describe('SC-57: step_del_N — удалить шаг', () => {
  test('шаг удаляется из БД', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    const sub  = subtaskService.createSubtask(task.id, 'Удалить меня');

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`step_del_${sub.id}`, ctx);

    expect(subtaskService.getSubtasks(task.id).length).toBe(0);
  });

  test('отвечает об ошибке при несуществующем шаге', async () => {
    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger('step_del_9999', ctx);
    expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('не найден'));
  });
});

// ─── SC-58: ai_steps_replace_N ───────────────────────────────────────────────

describe('SC-58: ai_steps_replace_N — заменить шаги AI-предложенными', () => {
  test('старые шаги заменяются AI-шагами', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    subtaskService.createSubtask(task.id, 'Старый шаг');

    // Устанавливаем pendingSteps как будто ai_steps уже отработал
    pendingTasks.set(USER_ID, {
      pendingSteps: { taskId: task.id, steps: ['Шаг A', 'Шаг B', 'Шаг C'], hasExisting: true },
    });

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`ai_steps_replace_${task.id}`, ctx);

    const subtasks = subtaskService.getSubtasks(task.id);
    expect(subtasks.length).toBe(3);
    expect(subtasks.map(s => s.title)).toEqual(['Шаг A', 'Шаг B', 'Шаг C']);
  });

  test('pendingSteps очищается после замены', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    pendingTasks.set(USER_ID, {
      pendingSteps: { taskId: task.id, steps: ['Шаг A'], hasExisting: false },
    });

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`ai_steps_replace_${task.id}`, ctx);

    expect(pendingTasks.get(USER_ID)?.pendingSteps).toBeUndefined();
  });

  test('устаревшая сессия — отвечает об ошибке', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    const ctx  = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`ai_steps_replace_${task.id}`, ctx);
    expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('устарела'));
  });
});

// ─── ai_steps_merge_N ─────────────────────────────────────────────────────────

describe('ai_steps_merge_N — добавить только новые шаги (без дубликатов)', () => {
  test('дубликаты не добавляются', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    subtaskService.createSubtask(task.id, 'Шаг A');

    pendingTasks.set(USER_ID, {
      pendingSteps: { taskId: task.id, steps: ['Шаг A', 'Шаг B'], hasExisting: true },
    });

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`ai_steps_merge_${task.id}`, ctx);

    const subtasks = subtaskService.getSubtasks(task.id);
    expect(subtasks.length).toBe(2); // Шаг A (старый) + Шаг B (новый)
    expect(subtasks.map(s => s.title)).toContain('Шаг B');
  });

  test('если все шаги уже есть — answerCbQuery говорит "Новых шагов нет"', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    subtaskService.createSubtask(task.id, 'Шаг A');

    pendingTasks.set(USER_ID, {
      pendingSteps: { taskId: task.id, steps: ['шаг a'], hasExisting: true },
    });

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`ai_steps_merge_${task.id}`, ctx);

    expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('Новых шагов нет'));
  });
});
