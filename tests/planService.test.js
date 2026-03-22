const { createTestDb } = require('./helpers/db');

let mockTestDb;
jest.mock('../src/db', () => mockTestDb);

let planService;

beforeEach(() => {
  mockTestDb = createTestDb();
  jest.resetModules();
  jest.mock('../src/db', () => mockTestDb);
  planService = require('../src/planService');
});

const USER_ID = 1;

describe('createPlan', () => {
  test('создаёт план с заголовком', () => {
    const plan = planService.createPlan(USER_ID, { title: 'Ремонт' });
    expect(plan.id).toBeDefined();
    expect(plan.title).toBe('Ремонт');
    expect(plan.status).toBe('active');
  });

  test('создаёт план с описанием', () => {
    const plan = planService.createPlan(USER_ID, { title: 'Ремонт', description: 'Полный ремонт кухни' });
    expect(plan.description).toBe('Полный ремонт кухни');
  });
});

describe('getPlanById', () => {
  test('возвращает план по id', () => {
    const created = planService.createPlan(USER_ID, { title: 'Тест' });
    const found = planService.getPlanById(created.id);
    expect(found.title).toBe('Тест');
  });

  test('возвращает undefined для несуществующего id', () => {
    expect(planService.getPlanById(9999)).toBeUndefined();
  });
});

describe('getPlanByTitle', () => {
  test('находит план по частичному совпадению', () => {
    planService.createPlan(USER_ID, { title: 'Ремонт квартиры' });
    const found = planService.getPlanByTitle(USER_ID, 'Ремонт');
    expect(found).toBeDefined();
    expect(found.title).toBe('Ремонт квартиры');
  });

  test('возвращает undefined если не найден', () => {
    const found = planService.getPlanByTitle(USER_ID, 'Несуществующий');
    expect(found).toBeUndefined();
  });
});

describe('updatePlan', () => {
  test('обновляет поля плана', () => {
    const plan = planService.createPlan(USER_ID, { title: 'Старый' });
    const updated = planService.updatePlan(plan.id, { title: 'Новый' });
    expect(updated.title).toBe('Новый');
  });

  test('сохраняет notion_page_id', () => {
    const plan = planService.createPlan(USER_ID, { title: 'План' });
    const updated = planService.updatePlan(plan.id, { notion_page_id: 'xyz-456' });
    expect(updated.notion_page_id).toBe('xyz-456');
  });
});

describe('archivePlan / restorePlan', () => {
  test('архивирует план', () => {
    const plan = planService.createPlan(USER_ID, { title: 'План' });
    planService.archivePlan(plan.id);
    const archived = planService.getPlanById(plan.id);
    expect(archived.status).toBe('archived');
  });

  test('восстанавливает архивный план', () => {
    const plan = planService.createPlan(USER_ID, { title: 'План' });
    planService.archivePlan(plan.id);
    planService.restorePlan(plan.id);
    const restored = planService.getPlanById(plan.id);
    expect(restored.status).toBe('active');
  });

  test('архивный план не виден в getPlansWithProgress', () => {
    const plan = planService.createPlan(USER_ID, { title: 'План' });
    planService.archivePlan(plan.id);
    const plans = planService.getPlansWithProgress(USER_ID);
    expect(plans.find(p => p.id === plan.id)).toBeUndefined();
  });
});

describe('deletePlan', () => {
  test('удаляет план', () => {
    const plan = planService.createPlan(USER_ID, { title: 'План' });
    planService.deletePlan(plan.id);
    expect(planService.getPlanById(plan.id)).toBeUndefined();
  });
});

describe('getArchivedPlans', () => {
  test('возвращает только архивные планы', () => {
    planService.createPlan(USER_ID, { title: 'Активный' });
    const plan = planService.createPlan(USER_ID, { title: 'Архивный' });
    planService.archivePlan(plan.id);
    const archived = planService.getArchivedPlans(USER_ID);
    expect(archived.length).toBe(1);
    expect(archived[0].title).toBe('Архивный');
  });
});
