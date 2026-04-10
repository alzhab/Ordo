const { createTestDb } = require('./helpers/db');

let mockTestDb;
jest.mock('../src/infrastructure/db/connection', () => mockTestDb);
jest.mock('../src/infrastructure/db/connection', () => mockTestDb);

let goalService;

beforeEach(() => {
  mockTestDb = createTestDb();
  jest.resetModules();
  jest.mock('../src/infrastructure/db/connection', () => mockTestDb);
  jest.mock('../src/infrastructure/db/connection', () => mockTestDb);
  goalService = require('../src/application/goals');
});

const USER_ID = 1;

describe('createGoal', () => {
  test('создаёт цель с заголовком', () => {
    const goal = goalService.createGoal(USER_ID, { title: 'Ремонт' });
    expect(goal.id).toBeDefined();
    expect(goal.title).toBe('Ремонт');
    expect(goal.status).toBe('active');
  });

  test('создаёт цель с описанием', () => {
    const goal = goalService.createGoal(USER_ID, { title: 'Ремонт', description: 'Полный ремонт кухни' });
    expect(goal.description).toBe('Полный ремонт кухни');
  });
});

describe('getGoalById', () => {
  test('возвращает цель по id', () => {
    const created = goalService.createGoal(USER_ID, { title: 'Тест' });
    const found = goalService.getGoalById(created.id);
    expect(found.title).toBe('Тест');
  });

  test('возвращает undefined для несуществующего id', () => {
    expect(goalService.getGoalById(9999)).toBeUndefined();
  });
});

describe('getGoalByTitle', () => {
  test('находит цель по частичному совпадению', () => {
    goalService.createGoal(USER_ID, { title: 'Ремонт квартиры' });
    const found = goalService.getGoalByTitle(USER_ID, 'Ремонт');
    expect(found).toBeDefined();
    expect(found.title).toBe('Ремонт квартиры');
  });

  test('возвращает undefined если не найден', () => {
    const found = goalService.getGoalByTitle(USER_ID, 'Несуществующий');
    expect(found).toBeUndefined();
  });
});

describe('updateGoal', () => {
  test('обновляет поля цели', () => {
    const goal = goalService.createGoal(USER_ID, { title: 'Старый' });
    const updated = goalService.updateGoal(goal.id, { title: 'Новый' });
    expect(updated.title).toBe('Новый');
  });

  test('сохраняет notion_page_id', () => {
    const goal = goalService.createGoal(USER_ID, { title: 'Цель' });
    const updated = goalService.updateGoal(goal.id, { notion_page_id: 'xyz-456' });
    expect(updated.notion_page_id).toBe('xyz-456');
  });
});

describe('archiveGoal / restoreGoal', () => {
  test('архивирует цель', () => {
    const goal = goalService.createGoal(USER_ID, { title: 'Цель' });
    goalService.archiveGoal(goal.id);
    const archived = goalService.getGoalById(goal.id);
    expect(archived.status).toBe('archived');
  });

  test('восстанавливает архивную цель', () => {
    const goal = goalService.createGoal(USER_ID, { title: 'Цель' });
    goalService.archiveGoal(goal.id);
    goalService.restoreGoal(goal.id);
    const restored = goalService.getGoalById(goal.id);
    expect(restored.status).toBe('active');
  });

  test('архивная цель не видна в getGoalsWithProgress', () => {
    const goal = goalService.createGoal(USER_ID, { title: 'Цель' });
    goalService.archiveGoal(goal.id);
    const goals = goalService.getGoalsWithProgress(USER_ID);
    expect(goals.find(g => g.id === goal.id)).toBeUndefined();
  });
});

describe('deleteGoal', () => {
  test('удаляет цель', () => {
    const goal = goalService.createGoal(USER_ID, { title: 'Цель' });
    goalService.deleteGoal(goal.id);
    expect(goalService.getGoalById(goal.id)).toBeUndefined();
  });
});

describe('getArchivedGoals', () => {
  test('возвращает только архивные цели', () => {
    goalService.createGoal(USER_ID, { title: 'Активный' });
    const goal = goalService.createGoal(USER_ID, { title: 'Архивный' });
    goalService.archiveGoal(goal.id);
    const archived = goalService.getArchivedGoals(USER_ID);
    expect(archived.length).toBe(1);
    expect(archived[0].title).toBe('Архивный');
  });
});
