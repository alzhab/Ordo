/**
 * Тесты сохранения planned_for и видимости задач в /plan.
 *
 * Покрытие:
 *   — plannedFor (camelCase) сохраняется в planned_for
 *   — planned_for (snake_case) сохраняется в planned_for (фолбэк)
 *   — задача без даты: planned_for = null
 *   — getTasksByPlannedDate возвращает только задачи на запрошенную дату
 *   — done / deleted задачи не появляются в /plan
 *   — изменение даты перемещает задачу между планами
 *   — снятие даты убирает задачу из /plan
 */

const { createTestDb } = require('../helpers/db');

let mockTestDb;
jest.mock('../../src/infrastructure/db/connection', () => mockTestDb);
jest.mock('../../src/infrastructure/db/connection', () => mockTestDb);

jest.mock('../../src/infrastructure/integrations/notion', () => ({
  isConfigured:         () => false,
  pushTask:             jest.fn().mockResolvedValue(null),
  updateTaskFields:     jest.fn().mockResolvedValue({}),
  updateTaskStatus:     jest.fn().mockResolvedValue({}),
  syncSubtasksToNotion: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../src/infrastructure/integrations/googleCalendar', () => ({
  isConnected: () => false,
  createEvent: jest.fn().mockResolvedValue(null),
}));

let taskService;
const USER_ID = 1;

beforeEach(() => {
  mockTestDb = createTestDb();
  jest.resetModules();
  jest.mock('../../src/infrastructure/db/connection', () => mockTestDb);
  jest.mock('../../src/infrastructure/integrations/notion', () => ({
    isConfigured:         () => false,
    pushTask:             jest.fn().mockResolvedValue(null),
    updateTaskFields:     jest.fn().mockResolvedValue({}),
    updateTaskStatus:     jest.fn().mockResolvedValue({}),
    syncSubtasksToNotion: jest.fn().mockResolvedValue([]),
  }));
  jest.mock('../../src/infrastructure/integrations/googleCalendar', () => ({
    isConnected: () => false,
    createEvent: jest.fn().mockResolvedValue(null),
  }));
  taskService = require('../../src/application/tasks');
});

describe('planned_for при создании задачи', () => {
  test('plannedFor (camelCase) сохраняется в planned_for', () => {
    const task = taskService.createTask(USER_ID, { title: 'Купить молоко', plannedFor: '2026-07-01' });
    expect(task.planned_for).toBe('2026-07-01');
  });

  test('planned_for (snake_case) сохраняется в planned_for', () => {
    const task = taskService.createTask(USER_ID, { title: 'Позвонить врачу', planned_for: '2026-07-01' });
    expect(task.planned_for).toBe('2026-07-01');
  });

  test('задача без даты имеет planned_for = null', () => {
    const task = taskService.createTask(USER_ID, { title: 'Без даты' });
    expect(task.planned_for).toBeNull();
  });

  test('дата обрезается до YYYY-MM-DD если передан datetime', () => {
    const task = taskService.createTask(USER_ID, { title: 'Точное время', plannedFor: '2026-07-01T15:00:00' });
    expect(task.planned_for).toBe('2026-07-01');
  });
});

describe('getTasksByPlannedDate — видимость в /plan', () => {
  test('задача с датой появляется в /plan на эту дату', () => {
    taskService.createTask(USER_ID, { title: 'Купить молоко', plannedFor: '2026-07-01' });
    const tasks = taskService.getTasksByPlannedDate(USER_ID, '2026-07-01');
    expect(tasks.length).toBe(1);
    expect(tasks[0].title).toBe('Купить молоко');
  });

  test('задача с датой не появляется в /plan на другую дату', () => {
    taskService.createTask(USER_ID, { title: 'Задача', plannedFor: '2026-07-01' });
    expect(taskService.getTasksByPlannedDate(USER_ID, '2026-07-02').length).toBe(0);
  });

  test('задача без даты не появляется в /plan', () => {
    taskService.createTask(USER_ID, { title: 'Без даты' });
    expect(taskService.getTasksByPlannedDate(USER_ID, '2026-07-01').length).toBe(0);
  });

  test('done-задача не появляется в /plan', () => {
    const task = taskService.createTask(USER_ID, { title: 'Выполнено', plannedFor: '2026-07-01' });
    taskService.updateTask(task.id, { status: 'done' });
    expect(taskService.getTasksByPlannedDate(USER_ID, '2026-07-01').length).toBe(0);
  });

  test('deleted-задача не появляется в /plan', () => {
    const task = taskService.createTask(USER_ID, { title: 'Удалено', plannedFor: '2026-07-01' });
    taskService.updateTask(task.id, { status: 'deleted' });
    expect(taskService.getTasksByPlannedDate(USER_ID, '2026-07-01').length).toBe(0);
  });

  test('несколько задач на одну дату возвращаются все', () => {
    taskService.createTask(USER_ID, { title: 'Задача 1', plannedFor: '2026-07-01' });
    taskService.createTask(USER_ID, { title: 'Задача 2', plannedFor: '2026-07-01' });
    taskService.createTask(USER_ID, { title: 'Другой день', plannedFor: '2026-07-02' });
    expect(taskService.getTasksByPlannedDate(USER_ID, '2026-07-01').length).toBe(2);
  });
});

describe('изменение даты', () => {
  test('изменение даты перемещает задачу в другой план', () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача', plannedFor: '2026-07-01' });
    taskService.updateTask(task.id, { planned_for: '2026-07-05' });
    expect(taskService.getTasksByPlannedDate(USER_ID, '2026-07-01').length).toBe(0);
    expect(taskService.getTasksByPlannedDate(USER_ID, '2026-07-05').length).toBe(1);
  });

  test('снятие даты убирает задачу из /plan', () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача', plannedFor: '2026-07-01' });
    taskService.updateTask(task.id, { planned_for: null });
    expect(taskService.getTasksByPlannedDate(USER_ID, '2026-07-01').length).toBe(0);
  });
});
