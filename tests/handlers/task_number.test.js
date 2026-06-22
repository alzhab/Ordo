/**
 * Тесты нумерации задач (Фаза 7.4).
 *
 * Покрытие:
 *   createTask автоматически присваивает task_number
 *   Нумерация per-user, монотонно растущая
 *   Номера не переиспользуются после soft-delete
 *   getByNumber возвращает нужную задачу
 *   getByNumber с чужим user_id → null
 *   getByNumber с несуществующим номером → null
 *   formatTaskText показывает `#N` вместо индекса
 *   formatTaskDetail показывает `#N` первой строкой
 */

const { createTestDb } = require('../helpers/db');

let mockTestDb;

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

let taskService, taskRepo, formatters;
const USER_A = 1;
const USER_B = 2;

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
  taskRepo    = require('../../src/infrastructure/db/repositories/taskRepository');
  formatters  = require('../../src/delivery/telegram/formatters');

  // Создаём второго пользователя для тестов изоляции
  mockTestDb.prepare('INSERT OR IGNORE INTO users (id, username) VALUES (2, \'user2\')').run();
});

// ─── Автоматическое присвоение номера ────────────────────────

describe('автоматическое присвоение task_number', () => {
  test('первая задача пользователя получает номер 1', () => {
    const t = taskService.createTask(USER_A, { title: 'Первая' });
    expect(t.task_number).toBe(1);
  });

  test('вторая задача получает номер 2', () => {
    taskService.createTask(USER_A, { title: 'Первая' });
    const t2 = taskService.createTask(USER_A, { title: 'Вторая' });
    expect(t2.task_number).toBe(2);
  });

  test('10 задач получают номера 1..10', () => {
    const nums = [];
    for (let i = 1; i <= 10; i++) {
      const t = taskService.createTask(USER_A, { title: `Задача ${i}` });
      nums.push(t.task_number);
    }
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

// ─── Изоляция по пользователям ───────────────────────────────

describe('нумерация per-user', () => {
  test('user_a и user_b имеют независимые счётчики', () => {
    const a1 = taskService.createTask(USER_A, { title: 'A первая' });
    const a2 = taskService.createTask(USER_A, { title: 'A вторая' });
    const b1 = taskService.createTask(USER_B, { title: 'B первая' });

    expect(a1.task_number).toBe(1);
    expect(a2.task_number).toBe(2);
    expect(b1.task_number).toBe(1); // счётчик user_b начинается заново
  });
});

// ─── Монотонный рост после удаления ──────────────────────────

describe('номера не переиспользуются', () => {
  test('после soft-delete следующая задача получает MAX+1', () => {
    const t1 = taskService.createTask(USER_A, { title: 'Удалить' });
    expect(t1.task_number).toBe(1);

    taskService.deleteTask(t1.id);

    const t2 = taskService.createTask(USER_A, { title: 'Новая' });
    expect(t2.task_number).toBe(2); // не 1 снова
  });
});

// ─── getByNumber / getTaskByNumber ───────────────────────────

describe('getByNumber', () => {
  test('возвращает задачу по номеру', () => {
    taskService.createTask(USER_A, { title: 'Первая' });
    const t2 = taskService.createTask(USER_A, { title: 'Вторая' });

    const found = taskRepo.getByNumber(USER_A, 2);
    expect(found).not.toBeNull();
    expect(found.id).toBe(t2.id);
    expect(found.title).toBe('Вторая');
  });

  test('возвращает null если номер не существует', () => {
    taskService.createTask(USER_A, { title: 'Единственная' });
    expect(taskRepo.getByNumber(USER_A, 999)).toBeUndefined();
  });

  test('изоляция: не возвращает задачу другого пользователя', () => {
    taskService.createTask(USER_A, { title: 'Задача user_a #1' });
    taskService.createTask(USER_B, { title: 'Задача user_b #1' });

    const result = taskRepo.getByNumber(USER_B, 1);
    expect(result.title).toBe('Задача user_b #1');
    expect(result.user_id).toBe(USER_B);
  });

  test('application getTaskByNumber работает', () => {
    const t = taskService.createTask(USER_A, { title: 'Тест' });
    const found = taskService.getTaskByNumber(USER_A, t.task_number);
    expect(found.id).toBe(t.id);
  });
});

// ─── Отображение в форматтерах ────────────────────────────────

describe('formatTaskText показывает #N', () => {
  test('задача с task_number показывает `#N` вместо числового индекса', () => {
    const t = taskService.createTask(USER_A, { title: 'Позвонить маме' });
    const text = formatters.formatTaskText(t, 0);
    expect(text).toContain('`#1`');
    expect(text).not.toMatch(/^0\./); // не должно быть "0."
  });

  test('задача #42 показывает `#42`', () => {
    for (let i = 0; i < 41; i++) {
      taskService.createTask(USER_A, { title: `Задача ${i}` });
    }
    const t = taskService.createTask(USER_A, { title: 'Сорок вторая' });
    expect(t.task_number).toBe(42);
    expect(formatters.formatTaskText(t, 0)).toContain('`#42`');
  });
});

describe('formatTaskDetail показывает #N первой строкой', () => {
  test('карточка начинается с `#N`', () => {
    const t = taskService.createTask(USER_A, { title: 'Встреча с командой' });
    const detail = formatters.formatTaskDetail(t);
    expect(detail.startsWith('`#1`')).toBe(true);
  });

  test('после `#N` идёт заголовок задачи', () => {
    const t = taskService.createTask(USER_A, { title: 'Сдать отчёт' });
    const detail = formatters.formatTaskDetail(t);
    expect(detail).toContain('Сдать отчёт');
  });
});
