/**
 * Тесты двухшагового диалога "В ожидании" из tasks.js + intent.js handleText.
 *
 * Покрытие:
 *   SC-29 — ts_waiting_N: устанавливает settingWaiting, запрашивает причину
 *   SC-30 — ввод причины → спрашивает дату; причина с датой → сразу сохраняет
 *   SC-31 — tw_skip_N на шаге reason: пропускает причину, переходит к дате
 *         — tw_skip_N на шаге until: завершает с null датой
 *   SC-32 — ввод даты → задача сохраняется в статусе waiting
 *         — полный флоу: причина → дата → waiting
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

jest.mock('../../src/infrastructure/ai/parser', () => ({
  parseIntent:     jest.fn(),
  suggestSubtasks: jest.fn(),
}));

// ─── Переменные ───────────────────────────────────────────────────────────────

let bot, taskService, pendingTasks, handleText;
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
  jest.mock('../../src/infrastructure/ai/parser', () => ({
    parseIntent:     jest.fn(),
    suggestSubtasks: jest.fn(),
  }));

  bot         = createMockBot();
  taskService = require('../../src/application/tasks');
  ({ pendingTasks } = require('../../src/shared/state'));
  ({ handleText } = require('../../src/delivery/telegram/handlers/intent'));

  require('../../src/delivery/telegram/handlers/tasks').register(bot);
});

// ─── SC-29: ts_waiting_N — кнопка ────────────────────────────────────────────

describe('SC-29: ts_waiting_N — инициирует диалог ожидания', () => {
  test('устанавливает settingWaiting с шагом reason', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    const ctx  = mockCtx({ userId: USER_ID, isCallback: true });

    await bot.trigger(`ts_waiting_${task.id}`, ctx);

    const state = pendingTasks.get(USER_ID);
    expect(state?.settingWaiting?.taskId).toBe(task.id);
    expect(state?.settingWaiting?.step).toBe('reason');
  });

  test('запрашивает причину ожидания', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    const ctx  = mockCtx({ userId: USER_ID, isCallback: true });

    await bot.trigger(`ts_waiting_${task.id}`, ctx);

    const [text] = ctx.editMessageText.mock.calls[0];
    expect(text).toContain('причину');
  });
});

// ─── SC-30: ввод причины ──────────────────────────────────────────────────────

describe('SC-30: текстовый ввод причины ожидания', () => {
  test('причина без даты → переходит к шагу until', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    pendingTasks.set(USER_ID, {
      settingWaiting: { taskId: task.id, step: 'reason' },
    });

    const ctx = mockCtx({ userId: USER_ID });
    await handleText(ctx, 'жду ответа от банка');

    const state = pendingTasks.get(USER_ID);
    expect(state?.settingWaiting?.step).toBe('until');
    expect(state?.settingWaiting?.waiting_reason).toBe('жду ответа от банка');
  });

  test('причина с датой → сразу сохраняет задачу как waiting', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    pendingTasks.set(USER_ID, {
      settingWaiting: { taskId: task.id, step: 'reason' },
    });

    const ctx = mockCtx({ userId: USER_ID });
    await handleText(ctx, 'заказ на WB придёт 2026-04-15');

    const updated = taskService.getTaskById(task.id);
    expect(updated.status).toBe('waiting');
    expect(updated.waiting_reason).toBe('заказ на WB придёт 2026-04-15');
    expect(updated.waiting_until).toBe('2026-04-15');
  });
});

// ─── SC-31: tw_skip_N ─────────────────────────────────────────────────────────

describe('SC-31: tw_skip_N — пропустить шаг в диалоге', () => {
  test('пропуск на шаге reason → переходит к шагу until', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    pendingTasks.set(USER_ID, {
      settingWaiting: { taskId: task.id, step: 'reason' },
    });

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`tw_skip_${task.id}`, ctx);

    const state = pendingTasks.get(USER_ID);
    expect(state?.settingWaiting?.step).toBe('until');
    expect(state?.settingWaiting?.waiting_reason).toBeNull();
  });

  test('пропуск на шаге until → задача сохраняется без даты', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    pendingTasks.set(USER_ID, {
      settingWaiting: { taskId: task.id, step: 'until', waiting_reason: 'причина' },
    });

    const ctx = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`tw_skip_${task.id}`, ctx);

    const updated = taskService.getTaskById(task.id);
    expect(updated.status).toBe('waiting');
    expect(updated.waiting_reason).toBe('причина');
    expect(updated.waiting_until).toBeNull();
  });

  test('устаревшая сессия — отвечает об ошибке', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    const ctx  = mockCtx({ userId: USER_ID, isCallback: true });

    await bot.trigger(`tw_skip_${task.id}`, ctx);

    expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('устарела'));
  });
});

// ─── SC-32: ввод даты ожидания ────────────────────────────────────────────────

describe('SC-32: ввод даты ожидания (шаг until)', () => {
  test('ISO-дата сохраняется в waiting_until', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    pendingTasks.set(USER_ID, {
      settingWaiting: { taskId: task.id, step: 'until', waiting_reason: 'жду посылку' },
    });

    const ctx = mockCtx({ userId: USER_ID });
    await handleText(ctx, '2026-04-20');

    const updated = taskService.getTaskById(task.id);
    expect(updated.status).toBe('waiting');
    expect(updated.waiting_until).toBe('2026-04-20');
  });

  test('нераспознанная дата → waiting_until равен null', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    pendingTasks.set(USER_ID, {
      settingWaiting: { taskId: task.id, step: 'until', waiting_reason: 'причина' },
    });

    const ctx = mockCtx({ userId: USER_ID });
    await handleText(ctx, 'не знаю когда');

    const updated = taskService.getTaskById(task.id);
    expect(updated.status).toBe('waiting');
    expect(updated.waiting_until).toBeNull();
  });
});

// ─── Полный флоу: причина → дата → waiting ───────────────────────────────────

describe('Полный флоу: ts_waiting → причина → дата', () => {
  test('задача получает статус waiting с заполненными полями', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Жду документы' });

    // 1. Нажать кнопку «В ожидание»
    const ctx1 = mockCtx({ userId: USER_ID, isCallback: true });
    await bot.trigger(`ts_waiting_${task.id}`, ctx1);

    // 2. Ввести причину
    const ctx2 = mockCtx({ userId: USER_ID });
    await handleText(ctx2, 'жду из налоговой');

    // 3. Ввести дату
    const ctx3 = mockCtx({ userId: USER_ID });
    await handleText(ctx3, '2026-05-01');

    const updated = taskService.getTaskById(task.id);
    expect(updated.status).toBe('waiting');
    expect(updated.waiting_reason).toBe('жду из налоговой');
    expect(updated.waiting_until).toBe('2026-05-01');
  });
});
