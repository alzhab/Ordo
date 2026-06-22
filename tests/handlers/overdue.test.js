/**
 * Тесты переноса просроченных задач.
 *
 * Покрытие moveOverdueTasks:
 *   — переносит todo-задачи с planned_for < today на today
 *   — не трогает: waiting, done, deleted, maybe
 *   — не трогает: is_recurring = 1
 *   — не трогает: planned_for = today, planned_for > today, planned_for = null
 *   — возвращает { id, user_id } перенесённых задач
 *   — переносит несколько задач за один вызов
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

function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

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

describe('moveOverdueTasks — что переносить', () => {
  test('переносит todo-задачу с yesterday на today', () => {
    taskService.createTask(USER_ID, { title: 'Просроченная', plannedFor: dateOffset(-1) });
    const moved = taskService.moveOverdueTasks();
    expect(moved.length).toBe(1);
    expect(taskService.getTaskById(moved[0].id).planned_for).toBe(dateOffset(0));
  });

  test('переносит задачу c позапрошлой недели', () => {
    taskService.createTask(USER_ID, { title: 'Давняя', plannedFor: dateOffset(-7) });
    const moved = taskService.moveOverdueTasks();
    expect(moved.length).toBe(1);
    expect(taskService.getTaskById(moved[0].id).planned_for).toBe(dateOffset(0));
  });

  test('возвращает id и user_id перенесённых задач', () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача', plannedFor: dateOffset(-1) });
    const moved = taskService.moveOverdueTasks();
    expect(moved[0].id).toBe(task.id);
    expect(moved[0].user_id).toBe(USER_ID);
  });

  test('переносит несколько задач за один вызов', () => {
    taskService.createTask(USER_ID, { title: 'Задача 1', plannedFor: dateOffset(-1) });
    taskService.createTask(USER_ID, { title: 'Задача 2', plannedFor: dateOffset(-3) });
    const moved = taskService.moveOverdueTasks();
    expect(moved.length).toBe(2);
    moved.forEach(({ id }) => {
      expect(taskService.getTaskById(id).planned_for).toBe(dateOffset(0));
    });
  });
});

describe('moveOverdueTasks — что не трогать', () => {
  test('не трогает задачу с planned_for = today', () => {
    taskService.createTask(USER_ID, { title: 'Сегодня', plannedFor: dateOffset(0) });
    expect(taskService.moveOverdueTasks().length).toBe(0);
  });

  test('не трогает задачу с будущей датой', () => {
    taskService.createTask(USER_ID, { title: 'Завтра', plannedFor: dateOffset(1) });
    expect(taskService.moveOverdueTasks().length).toBe(0);
  });

  test('не трогает задачу без даты', () => {
    taskService.createTask(USER_ID, { title: 'Без даты' });
    expect(taskService.moveOverdueTasks().length).toBe(0);
  });

  test('не трогает waiting-задачу', () => {
    const task = taskService.createTask(USER_ID, { title: 'Ждёт', plannedFor: dateOffset(-1) });
    taskService.updateTask(task.id, { status: 'waiting' });
    expect(taskService.moveOverdueTasks().length).toBe(0);
  });

  test('не трогает done-задачу', () => {
    const task = taskService.createTask(USER_ID, { title: 'Готово', plannedFor: dateOffset(-1) });
    taskService.updateTask(task.id, { status: 'done' });
    expect(taskService.moveOverdueTasks().length).toBe(0);
  });

  test('не трогает deleted-задачу', () => {
    const task = taskService.createTask(USER_ID, { title: 'Удалено', plannedFor: dateOffset(-1) });
    taskService.updateTask(task.id, { status: 'deleted' });
    expect(taskService.moveOverdueTasks().length).toBe(0);
  });

  test('не трогает повторяющуюся задачу (is_recurring = 1)', () => {
    taskService.createTask(USER_ID, { title: 'Повторяется', plannedFor: dateOffset(-1), is_recurring: 1 });
    expect(taskService.moveOverdueTasks().length).toBe(0);
  });
});
