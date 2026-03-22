const { createTestDb } = require('./helpers/db');

let mockTestDb;
jest.mock('../src/db', () => mockTestDb);

let categoryService;

beforeEach(() => {
  mockTestDb = createTestDb();
  jest.resetModules();
  jest.mock('../src/db', () => mockTestDb);
  categoryService = require('../src/categoryService');
});

const USER_ID = 1;

describe('createCategory', () => {
  test('создаёт категорию', () => {
    const cat = categoryService.createCategory(USER_ID, 'Путешествия');
    expect(cat.id).toBeDefined();
    expect(cat.name).toBe('Путешествия');
  });

  test('возвращает существующую при дубликате', () => {
    const first = categoryService.createCategory(USER_ID, 'Спорт');
    const second = categoryService.createCategory(USER_ID, 'Спорт');
    expect(second.id).toBe(first.id);
  });

  test('создаёт с цветом', () => {
    const cat = categoryService.createCategory(USER_ID, 'Цветная', '#ff0000');
    expect(cat.color).toBe('#ff0000');
  });
});

describe('getCategories', () => {
  test('возвращает список категорий пользователя', () => {
    categoryService.createCategory(USER_ID, 'Кат1');
    categoryService.createCategory(USER_ID, 'Кат2');
    const cats = categoryService.getCategories(USER_ID);
    expect(cats.length).toBeGreaterThanOrEqual(2);
  });
});

describe('getCategoryByName', () => {
  test('находит по точному имени', () => {
    categoryService.createCategory(USER_ID, 'Финансы');
    const found = categoryService.getCategoryByName(USER_ID, 'Финансы');
    expect(found).toBeDefined();
    expect(found.name).toBe('Финансы');
  });

  test('возвращает undefined если не найдено', () => {
    const found = categoryService.getCategoryByName(USER_ID, 'Несуществующая');
    expect(found).toBeUndefined();
  });
});

describe('getCategoryNames', () => {
  test('возвращает массив строк', () => {
    categoryService.createCategory(USER_ID, 'Наука');
    const names = categoryService.getCategoryNames(USER_ID);
    expect(Array.isArray(names)).toBe(true);
    expect(names).toContain('Наука');
  });
});

describe('ensureUser', () => {
  test('создаёт нового пользователя', () => {
    const NEW_USER = 999;
    categoryService.ensureUser(NEW_USER, 'newuser');
    // User exists if we can create a category for them
    const cat = categoryService.createCategory(NEW_USER, 'Тест');
    expect(cat).toBeDefined();
  });

  test('не падает если пользователь уже существует', () => {
    expect(() => categoryService.ensureUser(USER_ID, 'testuser')).not.toThrow();
  });
});
