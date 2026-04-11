const { createTestDb } = require('./helpers/db');

let mockTestDb;
jest.mock('../src/infrastructure/db/connection', () => mockTestDb);

let settings;

beforeEach(() => {
  mockTestDb = createTestDb();
  jest.resetModules();
  jest.mock('../src/infrastructure/db/connection', () => mockTestDb);
  settings = require('../src/application/settings');
});

const USER_ID = 1;

describe('getNotionEnabled', () => {
  test('по умолчанию возвращает true', () => {
    expect(settings.getNotionEnabled(USER_ID)).toBe(true);
  });

  test('возвращает true если notion_enabled = 1', () => {
    settings.updateSettings(USER_ID, { notion_enabled: 1 });
    expect(settings.getNotionEnabled(USER_ID)).toBe(true);
  });

  test('возвращает false после выключения', () => {
    settings.updateSettings(USER_ID, { notion_enabled: 0 });
    expect(settings.getNotionEnabled(USER_ID)).toBe(false);
  });

  test('возвращает true после повторного включения', () => {
    settings.updateSettings(USER_ID, { notion_enabled: 0 });
    settings.updateSettings(USER_ID, { notion_enabled: 1 });
    expect(settings.getNotionEnabled(USER_ID)).toBe(true);
  });
});

describe('updateSettings notion_enabled', () => {
  test('notion_enabled входит в список разрешённых полей', () => {
    settings.updateSettings(USER_ID, { notion_enabled: 0 });
    const row = settings.getSettings(USER_ID);
    expect(row.notion_enabled).toBe(0);
  });

  test('другие настройки не затрагиваются при обновлении notion_enabled', () => {
    settings.updateSettings(USER_ID, { plan_time: '08:00' });
    settings.updateSettings(USER_ID, { notion_enabled: 0 });
    const row = settings.getSettings(USER_ID);
    expect(row.plan_time).toBe('08:00');
    expect(row.notion_enabled).toBe(0);
  });
});
