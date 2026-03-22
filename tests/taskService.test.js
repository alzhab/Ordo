const { createTestDb } = require('./helpers/db');

// Мокаем db.js чтобы использовать тестовую БД
let mockTestDb;
jest.mock('../src/db', () => mockTestDb);

let taskService;
let categoryService;

beforeEach(() => {
  mockTestDb = createTestDb();
  jest.resetModules();
  jest.mock('../src/db', () => mockTestDb);
  taskService = require('../src/taskService');
  categoryService = require('../src/categoryService');
});

const USER_ID = 1;

describe('createTask', () => {
  test('создаёт задачу с минимальными полями', () => {
    const task = taskService.createTask(USER_ID, { title: 'Купить молоко' });
    expect(task.id).toBeDefined();
    expect(task.title).toBe('Купить молоко');
    expect(task.status).toBe('not_started');
    expect(task.user_id).toBe(USER_ID);
  });

  test('создаёт задачу со всеми полями', () => {
    const task = taskService.createTask(USER_ID, {
      title: 'Задача',
      description: 'Описание',
      priority: 'Высокий',
      dueDate: '2026-12-31',
    });
    expect(task.description).toBe('Описание');
    expect(task.due_date).toBe('2026-12-31');
  });

  test('автоматически создаёт категорию если не существует', () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача', category: 'Работа' });
    expect(task.category_name).toBe('Работа');
  });

  test('использует существующую категорию', () => {
    const cat = categoryService.createCategory(USER_ID, 'Дом');
    const task = taskService.createTask(USER_ID, { title: 'Задача', category: 'Дом' });
    expect(task.category_id).toBe(cat.id);
  });
});

describe('getTaskById', () => {
  test('возвращает задачу по id', () => {
    const created = taskService.createTask(USER_ID, { title: 'Тест' });
    const found = taskService.getTaskById(created.id);
    expect(found.title).toBe('Тест');
  });

  test('возвращает undefined для несуществующего id', () => {
    const found = taskService.getTaskById(9999);
    expect(found).toBeUndefined();
  });
});

describe('getTasks', () => {
  test('возвращает все задачи пользователя', () => {
    taskService.createTask(USER_ID, { title: 'Задача 1' });
    taskService.createTask(USER_ID, { title: 'Задача 2' });
    const tasks = taskService.getTasks(USER_ID);
    expect(tasks.length).toBe(2);
  });

  test('не возвращает удалённые задачи', () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    taskService.deleteTask(task.id);
    const tasks = taskService.getTasks(USER_ID);
    expect(tasks.length).toBe(0);
  });

  test('фильтрует по статусу', () => {
    const t1 = taskService.createTask(USER_ID, { title: 'Задача 1' });
    taskService.createTask(USER_ID, { title: 'Задача 2' });
    taskService.updateTask(t1.id, { status: 'done' });
    const done = taskService.getTasks(USER_ID, { status: 'done' });
    expect(done.length).toBe(1);
    expect(done[0].title).toBe('Задача 1');
  });

  test('фильтрует по поиску', () => {
    taskService.createTask(USER_ID, { title: 'Купить молоко' });
    taskService.createTask(USER_ID, { title: 'Позвонить врачу' });
    const results = taskService.getTasks(USER_ID, { search: 'молоко' });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Купить молоко');
  });
});

describe('updateTask', () => {
  test('обновляет поля задачи', () => {
    const task = taskService.createTask(USER_ID, { title: 'Старое' });
    const updated = taskService.updateTask(task.id, { title: 'Новое', status: 'in_progress' });
    expect(updated.title).toBe('Новое');
    expect(updated.status).toBe('in_progress');
  });

  test('сохраняет notion_page_id', () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    const updated = taskService.updateTask(task.id, { notion_page_id: 'abc-123' });
    expect(updated.notion_page_id).toBe('abc-123');
  });

  test('игнорирует неразрешённые поля', () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    const updated = taskService.updateTask(task.id, { hacked: 'value', title: 'Норм' });
    expect(updated.title).toBe('Норм');
    expect(updated.hacked).toBeUndefined();
  });
});

describe('deleteTask', () => {
  test('переводит задачу в статус deleted', () => {
    const task = taskService.createTask(USER_ID, { title: 'Задача' });
    taskService.deleteTask(task.id);
    const found = taskService.getTaskById(task.id);
    expect(found.status).toBe('deleted');
  });
});

describe('getTasksToday', () => {
  test('возвращает задачи с дедлайном сегодня', () => {
    const today = new Date().toISOString().split('T')[0];
    taskService.createTask(USER_ID, { title: 'Сегодня', dueDate: today });
    taskService.createTask(USER_ID, { title: 'Без даты' });
    const tasks = taskService.getTasksToday(USER_ID);
    expect(tasks.length).toBe(1);
    expect(tasks[0].title).toBe('Сегодня');
  });
});
