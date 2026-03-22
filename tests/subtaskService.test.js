const { createTestDb } = require('./helpers/db');

let mockTestDb;
jest.mock('../src/db', () => mockTestDb);

let subtaskService;
let taskService;

beforeEach(() => {
  mockTestDb = createTestDb();
  jest.resetModules();
  jest.mock('../src/db', () => mockTestDb);
  subtaskService = require('../src/subtaskService');
  taskService = require('../src/taskService');
});

const USER_ID = 1;

function makeTask() {
  return taskService.createTask(USER_ID, { title: 'Тестовая задача' });
}

describe('createSubtask', () => {
  test('создаёт подзадачу', () => {
    const task = makeTask();
    const sub = subtaskService.createSubtask(task.id, 'Шаг 1');
    expect(sub.id).toBeDefined();
    expect(sub.title).toBe('Шаг 1');
    expect(sub.is_done).toBe(0);
    expect(sub.task_id).toBe(task.id);
  });

  test('автоинкремент позиции', () => {
    const task = makeTask();
    const s1 = subtaskService.createSubtask(task.id, 'Шаг 1');
    const s2 = subtaskService.createSubtask(task.id, 'Шаг 2');
    expect(s2.position).toBeGreaterThan(s1.position);
  });
});

describe('createSubtasks', () => {
  test('создаёт несколько подзадач сразу', () => {
    const task = makeTask();
    const subs = subtaskService.createSubtasks(task.id, ['Шаг 1', 'Шаг 2', 'Шаг 3']);
    expect(subs.length).toBe(3);
    expect(subs[0].title).toBe('Шаг 1');
  });
});

describe('getSubtasks', () => {
  test('возвращает все подзадачи задачи', () => {
    const task = makeTask();
    subtaskService.createSubtasks(task.id, ['А', 'Б', 'В']);
    const subs = subtaskService.getSubtasks(task.id);
    expect(subs.length).toBe(3);
  });

  test('возвращает пустой массив если подзадач нет', () => {
    const task = makeTask();
    expect(subtaskService.getSubtasks(task.id)).toEqual([]);
  });
});

describe('toggleSubtask', () => {
  test('переключает is_done с 0 на 1', () => {
    const task = makeTask();
    const sub = subtaskService.createSubtask(task.id, 'Шаг');
    const toggled = subtaskService.toggleSubtask(sub.id);
    expect(toggled.is_done).toBe(1);
  });

  test('переключает is_done с 1 на 0', () => {
    const task = makeTask();
    const sub = subtaskService.createSubtask(task.id, 'Шаг');
    subtaskService.toggleSubtask(sub.id);
    const toggled = subtaskService.toggleSubtask(sub.id);
    expect(toggled.is_done).toBe(0);
  });
});

describe('updateSubtask', () => {
  test('обновляет название', () => {
    const task = makeTask();
    const sub = subtaskService.createSubtask(task.id, 'Старое');
    const updated = subtaskService.updateSubtask(sub.id, { title: 'Новое' });
    expect(updated.title).toBe('Новое');
  });

  test('сохраняет notion_block_id', () => {
    const task = makeTask();
    const sub = subtaskService.createSubtask(task.id, 'Шаг');
    const updated = subtaskService.updateSubtask(sub.id, { notion_block_id: 'block-abc' });
    expect(updated.notion_block_id).toBe('block-abc');
  });
});

describe('deleteSubtask', () => {
  test('удаляет подзадачу', () => {
    const task = makeTask();
    const sub = subtaskService.createSubtask(task.id, 'Шаг');
    subtaskService.deleteSubtask(sub.id);
    expect(subtaskService.getSubtaskById(sub.id)).toBeUndefined();
  });
});

describe('deleteAllSubtasks', () => {
  test('удаляет все подзадачи задачи', () => {
    const task = makeTask();
    subtaskService.createSubtasks(task.id, ['А', 'Б', 'В']);
    subtaskService.deleteAllSubtasks(task.id);
    expect(subtaskService.getSubtasks(task.id)).toEqual([]);
  });
});
