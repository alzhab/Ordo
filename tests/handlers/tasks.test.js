/**
 * Handler-level тесты для High-priority сценариев из SCENARIOS.md.
 *
 * Покрытие:
 *   SC-01  — create_task: простая задача → превью + state
 *   SC-03  — create_task: с подзадачами → state.task.subtasks
 *   SC-05  — create_task: автоопределение waiting → state.task.status
 *   SC-26  — executeTaskAction: update_status → in_progress
 *   SC-27  — executeTaskAction: update_status → done
 *   SC-28  — button handler: выход из waiting очищает waiting поля (через taskService)
 *   SC-29  — executeTaskAction: manage_task голосом → update_status
 *   SC-30  — waiting dialog шаг 1: причина без даты → переходит к шагу 'until'
 *   SC-31  — waiting dialog шаг 1: дата в причине → финализирует сразу
 *   SC-32  — waiting dialog шаг 2: вводим дату → финализирует с waiting_until
 *   SC-33  — formatWaitingUntil: просроченная дата → показывает ⚠️
 *   SC-34  — executeTaskAction: delete → показывает диалог подтверждения
 *   SC-68  — executeTaskAction: set_waiting голосом → устанавливает waiting поля
 *   SC-69  — filter persistence: фильтр сохраняется при навигации
 */

const { createTestDb } = require('../helpers/db');
const { mockCtx }      = require('../helpers/ctx');

// ─── Мокируем зависимости ДО require ────────────────────────────────────────

let mockTestDb;
jest.mock('../../src/db', () => mockTestDb);

jest.mock('../../src/integrations/notion', () => ({
  isConfigured:          () => false,
  isPlansConfigured:     () => false,
  pushTask:              jest.fn().mockResolvedValue('notion-page-id'),
  updateTaskFields:      jest.fn().mockResolvedValue({}),
  updateTaskStatus:      jest.fn().mockResolvedValue({}),
  pushPlan:              jest.fn().mockResolvedValue('notion-plan-id'),
  syncSubtasksToNotion:  jest.fn().mockResolvedValue([]),
  appendSubtaskToNotion: jest.fn().mockResolvedValue('block-id'),
  updateSubtaskBlockTitle: jest.fn().mockResolvedValue({}),
  archiveNotionPage:     jest.fn().mockResolvedValue({}),
  unarchiveNotionPage:   jest.fn().mockResolvedValue({}),
  updatePlanFields:      jest.fn().mockResolvedValue({}),
}));

jest.mock('../../src/parser', () => ({
  parseIntent:     jest.fn(),
  suggestSubtasks: jest.fn(),
}));

// ─── Переменные для модулей (пересоздаются в beforeEach) ─────────────────────

let handleText, executeTaskAction;
let pendingTasks, taskFilters, getFilter;
let taskService;
let parseIntent;

const USER_ID = 1;

beforeEach(() => {
  mockTestDb = createTestDb();
  jest.resetModules();

  jest.mock('../../src/db', () => mockTestDb);
  jest.mock('../../src/integrations/notion', () => ({
    isConfigured:          () => false,
    isPlansConfigured:     () => false,
    pushTask:              jest.fn().mockResolvedValue('notion-page-id'),
    updateTaskFields:      jest.fn().mockResolvedValue({}),
    updateTaskStatus:      jest.fn().mockResolvedValue({}),
    pushPlan:              jest.fn().mockResolvedValue('notion-plan-id'),
    syncSubtasksToNotion:  jest.fn().mockResolvedValue([]),
    appendSubtaskToNotion: jest.fn().mockResolvedValue('block-id'),
    updateSubtaskBlockTitle: jest.fn().mockResolvedValue({}),
    archiveNotionPage:     jest.fn().mockResolvedValue({}),
    unarchiveNotionPage:   jest.fn().mockResolvedValue({}),
    updatePlanFields:      jest.fn().mockResolvedValue({}),
  }));
  jest.mock('../../src/parser', () => ({
    parseIntent:     jest.fn(),
    suggestSubtasks: jest.fn(),
  }));

  ({ handleText, executeTaskAction } = require('../../src/handlers/intent'));
  ({ pendingTasks, taskFilters, getFilter } = require('../../src/state'));
  taskService = require('../../src/taskService');
  ({ parseIntent } = require('../../src/parser'));
});

// ─── SC-01: create_task — простая задача ─────────────────────────────────────

describe('SC-01: create_task — простая задача', () => {
  test('показывает превью и сохраняет state', async () => {
    parseIntent.mockResolvedValueOnce({
      intent: 'create_task', title: 'Купить молоко',
      category: null, status: null, description: null,
      dueDate: null, priority: null, plan: null, subtasks: null,
    });

    const ctx = mockCtx({ userId: USER_ID });
    await handleText(ctx, 'Купить молоко');

    // Превью отправлено
    const previewCall = ctx.reply.mock.calls.find(
      ([text]) => typeof text === 'string' && text.includes('Купить молоко')
    );
    expect(previewCall).toBeDefined();

    // State установлен
    const state = pendingTasks.get(USER_ID);
    expect(state.task.title).toBe('Купить молоко');
    expect(state.task.category).toBe('Общее'); // дефолтная категория
  });

  test('категория из парсера сохраняется в state', async () => {
    parseIntent.mockResolvedValueOnce({
      intent: 'create_task', title: 'Сдать отчёт',
      category: 'Работа', status: null, description: null,
      dueDate: '2026-03-28', priority: 'Высокий', plan: null, subtasks: null,
    });

    const ctx = mockCtx({ userId: USER_ID });
    await handleText(ctx, 'Сдать отчёт по работе в пятницу');

    const state = pendingTasks.get(USER_ID);
    expect(state.task.category).toBe('Работа');
    expect(state.task.dueDate).toBe('2026-03-28');
    expect(state.task.priority).toBe('Высокий');
  });

  test('при ошибке парсера отвечает сообщением об ошибке', async () => {
    parseIntent.mockRejectedValueOnce(new Error('API error'));

    const ctx = mockCtx({ userId: USER_ID });
    await handleText(ctx, 'Что-то непонятное');

    const errorCall = ctx.reply.mock.calls.find(
      ([text]) => typeof text === 'string' && text.includes('Не удалось распознать')
    );
    expect(errorCall).toBeDefined();
    expect(pendingTasks.get(USER_ID)).toBeUndefined();
  });
});

// ─── SC-03: create_task — с подзадачами ──────────────────────────────────────

describe('SC-03: create_task — задача с подзадачами', () => {
  test('подзадачи попадают в state', async () => {
    parseIntent.mockResolvedValueOnce({
      intent: 'create_task', title: 'Подготовить презентацию',
      category: 'Работа', status: null, description: null,
      dueDate: null, priority: null, plan: null,
      subtasks: ['Сделать слайды', 'Собрать данные', 'Согласовать с командой'],
    });

    const ctx = mockCtx({ userId: USER_ID });
    await handleText(ctx, 'Подготовить презентацию: слайды, данные, согласование');

    const state = pendingTasks.get(USER_ID);
    expect(state.task.subtasks).toHaveLength(3);
    expect(state.task.subtasks[0]).toBe('Сделать слайды');
  });
});

// ─── SC-05: create_task — автоопределение waiting ─────────────────────────────

describe('SC-05: create_task — автоопределение waiting', () => {
  test('статус waiting и поля ожидания попадают в state', async () => {
    parseIntent.mockResolvedValueOnce({
      intent: 'create_task', title: 'Записался на приём к врачу',
      category: null, status: 'waiting',
      waiting_reason: 'приём у врача', waiting_until: '2026-03-28',
      description: null, dueDate: null, priority: null, plan: null, subtasks: null,
    });

    const ctx = mockCtx({ userId: USER_ID });
    await handleText(ctx, 'Записался на приём к врачу на пятницу');

    const state = pendingTasks.get(USER_ID);
    expect(state.task.status).toBe('waiting');
    expect(state.task.waiting_reason).toBe('приём у врача');
    expect(state.task.waiting_until).toBe('2026-03-28');
  });

  test('превью содержит "В ожидании" для waiting задачи', async () => {
    parseIntent.mockResolvedValueOnce({
      intent: 'create_task', title: 'Заказал вешалки на WB',
      category: null, status: 'waiting',
      waiting_reason: 'заказ на WB', waiting_until: '2026-03-25',
      description: null, dueDate: null, priority: null, plan: null, subtasks: null,
    });

    const ctx = mockCtx({ userId: USER_ID });
    await handleText(ctx, 'Заказал вешалки на WB, придут 25 марта');

    const previewCall = ctx.reply.mock.calls.find(
      ([text]) => typeof text === 'string' && text.includes('В ожидании')
    );
    expect(previewCall).toBeDefined();
  });
});

// ─── SC-26/SC-27/SC-29: executeTaskAction — update_status ─────────────────────

describe('SC-26/SC-27/SC-29: executeTaskAction — смена статуса', () => {
  let task;

  beforeEach(() => {
    task = taskService.createTask(USER_ID, { title: 'Тестовая задача' });
  });

  test('SC-26: переводит задачу в in_progress', async () => {
    const ctx = mockCtx({ userId: USER_ID });
    await executeTaskAction(ctx, USER_ID, task, { action: 'update_status', status: 'in_progress' });

    const updated = taskService.getTaskById(task.id);
    expect(updated.status).toBe('in_progress');
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('В работе'),
      expect.anything()
    );
  });

  test('SC-27: переводит задачу в done', async () => {
    const ctx = mockCtx({ userId: USER_ID });
    await executeTaskAction(ctx, USER_ID, task, { action: 'update_status', status: 'done' });

    const updated = taskService.getTaskById(task.id);
    expect(updated.status).toBe('done');
  });

  test('SC-29: голосовая смена статуса обновляет задачу', async () => {
    task = taskService.updateTask(task.id, { status: 'in_progress' });
    const ctx = mockCtx({ userId: USER_ID });
    await executeTaskAction(ctx, USER_ID, task, { action: 'update_status', status: 'done' });

    expect(taskService.getTaskById(task.id).status).toBe('done');
  });
});

// ─── SC-28: выход из waiting через taskService ────────────────────────────────

describe('SC-28: выход из статуса waiting очищает waiting поля', () => {
  test('updateTask с новым статусом + null полями очищает waiting', () => {
    // Создаём waiting задачу
    let task = taskService.createTask(USER_ID, {
      title: 'Жду доставку',
      status: 'waiting',
      waiting_reason: 'посылка на почте',
      waiting_until: '2026-03-25',
    });

    // Симулируем поведение button-handler при выходе из waiting
    const updated = taskService.updateTask(task.id, {
      status: 'in_progress',
      waiting_reason: null,
      waiting_until:  null,
    });

    expect(updated.status).toBe('in_progress');
    expect(updated.waiting_reason).toBeNull();
    expect(updated.waiting_until).toBeNull();
  });
});

// ─── SC-34: executeTaskAction — удаление ─────────────────────────────────────

describe('SC-34: executeTaskAction — удаление показывает диалог подтверждения', () => {
  test('показывает запрос подтверждения, задача ещё не удалена', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Удалить меня' });
    const ctx  = mockCtx({ userId: USER_ID });

    await executeTaskAction(ctx, USER_ID, task, { action: 'delete' });

    // Диалог подтверждения показан
    const confirmCall = ctx.reply.mock.calls.find(
      ([text]) => typeof text === 'string' && text.includes('Удалить')
    );
    expect(confirmCall).toBeDefined();

    // Задача ещё не удалена
    const found = taskService.getTaskById(task.id);
    expect(found.status).not.toBe('deleted');
  });
});

// ─── SC-68: executeTaskAction — set_waiting голосом ──────────────────────────

describe('SC-68: executeTaskAction — голосовой set_waiting', () => {
  test('устанавливает статус waiting с reason и until', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Купить запчасти' });
    const ctx  = mockCtx({ userId: USER_ID });

    await executeTaskAction(ctx, USER_ID, task, {
      action:         'set_waiting',
      waiting_reason: 'жду доставку',
      waiting_until:  '2026-03-25',
    });

    const updated = taskService.getTaskById(task.id);
    expect(updated.status).toBe('waiting');
    expect(updated.waiting_reason).toBe('жду доставку');
    expect(updated.waiting_until).toBe('2026-03-25');
  });

  test('set_waiting без until — waiting_until остаётся null', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Жду ответа' });
    const ctx  = mockCtx({ userId: USER_ID });

    await executeTaskAction(ctx, USER_ID, task, {
      action:         'set_waiting',
      waiting_reason: 'жду ответа от клиента',
      waiting_until:  null,
    });

    const updated = taskService.getTaskById(task.id);
    expect(updated.status).toBe('waiting');
    expect(updated.waiting_reason).toBe('жду ответа от клиента');
    expect(updated.waiting_until).toBeNull();
  });

  test('SC-31 + SC-68: дата в тексте причины извлекается через normalizeWaiting', async () => {
    const task = taskService.createTask(USER_ID, { title: 'Заказ на WB' });
    const ctx  = mockCtx({ userId: USER_ID });

    // waiting_until = null, но дата "спрятана" в причине — normalizeWaiting извлечёт её
    const futureDate = new Date(); futureDate.setDate(futureDate.getDate() + 10);
    const futureDateStr = futureDate.toISOString().slice(0, 10);
    const days = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
    const futureText = `${futureDate.getDate()} ${days[futureDate.getMonth()]}`;

    await executeTaskAction(ctx, USER_ID, task, {
      action:         'set_waiting',
      waiting_reason: `заказ на WB придёт ${futureText}`,
      waiting_until:  null,
    });

    const updated = taskService.getTaskById(task.id);
    expect(updated.status).toBe('waiting');
    // Дата извлечена из причины (возможен ±1 день из-за timezone, но не null)
    expect(updated.waiting_until).not.toBeNull();
    const expectedYear = futureDateStr.slice(0, 4);
    expect(updated.waiting_until).toMatch(new RegExp(`^${expectedYear}-`));
  });
});

// ─── SC-30..SC-32: waiting dialog через handleText ───────────────────────────

describe('SC-30..SC-32: waiting dialog (многошаговый)', () => {
  let task;

  beforeEach(() => {
    task = taskService.createTask(USER_ID, { title: 'Купить запчасти' });
  });

  test('SC-30: причина без даты → переходит к шагу until', async () => {
    pendingTasks.set(USER_ID, {
      settingWaiting: { taskId: task.id, step: 'reason' },
    });

    const ctx = mockCtx({ userId: USER_ID });
    await handleText(ctx, 'жду ответа от клиента');

    // Бот спрашивает дату
    const askUntil = ctx.reply.mock.calls.find(
      ([text]) => typeof text === 'string' && text.includes('До какой даты')
    );
    expect(askUntil).toBeDefined();

    // State переходит на шаг 'until'
    const state = pendingTasks.get(USER_ID);
    expect(state.settingWaiting.step).toBe('until');
    expect(state.settingWaiting.waiting_reason).toBe('жду ответа от клиента');
  });

  test('SC-31: дата в причине — финализирует сразу без шага until', async () => {
    pendingTasks.set(USER_ID, {
      settingWaiting: { taskId: task.id, step: 'reason' },
    });

    const ctx = mockCtx({ userId: USER_ID });
    const futureDate = new Date(); futureDate.setDate(futureDate.getDate() + 10);
    const futureDateStr = futureDate.toISOString().slice(0, 10);
    const days = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
    const futureText = `${futureDate.getDate()} ${days[futureDate.getMonth()]}`;

    await handleText(ctx, `заказ на WB придёт ${futureText}`);

    // Задача обновлена сразу
    const updated = taskService.getTaskById(task.id);
    expect(updated.status).toBe('waiting');
    // Дата извлечена (±1 день из-за timezone, но не null)
    expect(updated.waiting_until).not.toBeNull();
    const expectedYear = futureDateStr.slice(0, 4);
    expect(updated.waiting_until).toMatch(new RegExp(`^${expectedYear}-`));

    // settingWaiting очищен
    const state = pendingTasks.get(USER_ID);
    expect(state?.settingWaiting).toBeUndefined();

    // Шаг 'until' не показывался
    const askUntil = ctx.reply.mock.calls.find(
      ([text]) => typeof text === 'string' && text.includes('До какой даты')
    );
    expect(askUntil).toBeUndefined();
  });

  test('SC-32: шаг until — вводим дату, задача финализируется', async () => {
    pendingTasks.set(USER_ID, {
      settingWaiting: {
        taskId: task.id,
        step: 'until',
        waiting_reason: 'жду ответа',
      },
    });

    const ctx = mockCtx({ userId: USER_ID });
    await handleText(ctx, 'в пятницу');

    const updated = taskService.getTaskById(task.id);
    expect(updated.status).toBe('waiting');
    expect(updated.waiting_reason).toBe('жду ответа');
    // waiting_until = ближайшая пятница (не null)
    expect(updated.waiting_until).not.toBeNull();

    // settingWaiting очищен
    const state = pendingTasks.get(USER_ID);
    expect(state?.settingWaiting).toBeUndefined();
  });

  test('SC-32: шаг until — ISO дата финализирует точно', async () => {
    pendingTasks.set(USER_ID, {
      settingWaiting: {
        taskId: task.id,
        step: 'until',
        waiting_reason: 'жду ответа',
      },
    });

    const ctx = mockCtx({ userId: USER_ID });
    await handleText(ctx, '2026-04-10');

    const updated = taskService.getTaskById(task.id);
    expect(updated.status).toBe('waiting');
    expect(updated.waiting_reason).toBe('жду ответа');
    expect(updated.waiting_until).toBe('2026-04-10');
    expect(pendingTasks.get(USER_ID)?.settingWaiting).toBeUndefined();
  });

  // ЗАМЕТКА: "Пропустить" через кнопку (action tw_skip_N) устанавливает waiting_until=null.
  // Тестируется через taskService напрямую:
  test('updateTask с waiting_until=null корректно сохраняет null', () => {
    taskService.updateTask(task.id, { status: 'waiting', waiting_reason: 'жду', waiting_until: null });
    const updated = taskService.getTaskById(task.id);
    expect(updated.waiting_until).toBeNull();
  });
});

// ─── SC-33: formatWaitingUntil — просроченная дата ───────────────────────────

describe('SC-33: formatWaitingUntil — отображение просроченной даты', () => {
  test('просроченная дата получает префикс ⚠️', () => {
    const { formatWaitingUntil } = require('../../src/formatters');
    const past = '2020-01-15';
    expect(formatWaitingUntil(past)).toMatch(/^⚠️/);
  });

  test('будущая дата не имеет ⚠️', () => {
    const { formatWaitingUntil } = require('../../src/formatters');
    const future = '2099-12-31';
    expect(formatWaitingUntil(future)).not.toMatch(/^⚠️/);
  });

  test('null возвращает null', () => {
    const { formatWaitingUntil } = require('../../src/formatters');
    expect(formatWaitingUntil(null)).toBeNull();
  });
});

// ─── SC-69: filter persistence ───────────────────────────────────────────────

describe('SC-69: filter persistence', () => {
  test('дефолтный фильтр — пустой объект', () => {
    const filter = getFilter(USER_ID);
    expect(filter.status).toBeUndefined();
  });

  test('установленный фильтр сохраняется при повторном вызове getFilter', () => {
    const filter = getFilter(USER_ID);
    filter.category = 'Работа';
    filter.status = 'todo';
    taskFilters.set(USER_ID, filter);

    const retrieved = getFilter(USER_ID);
    expect(retrieved.category).toBe('Работа');
    expect(retrieved.status).toBe('todo');
  });

  test('несколько фильтров сохраняются вместе', () => {
    const filter = getFilter(USER_ID);
    filter.category = 'Работа';
    filter.status   = 'todo';
    taskFilters.set(USER_ID, filter);

    const retrieved = getFilter(USER_ID);
    expect(retrieved.category).toBe('Работа');
    expect(retrieved.status).toBe('todo');
  });

  test('фильтры разных пользователей изолированы', () => {
    const f1 = getFilter(1);
    f1.category = 'Работа';
    taskFilters.set(1, f1);

    const f2 = getFilter(2);
    expect(f2.category).toBeUndefined();
  });
});
