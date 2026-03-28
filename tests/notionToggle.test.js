const { createTestDb } = require('./helpers/db');

// Мокаем Anthropic SDK до импорта assistantService
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: jest.fn() },
  }));
});

let mockTestDb;
jest.mock('../src/db', () => mockTestDb);

let assistantService;

beforeEach(() => {
  mockTestDb = createTestDb();
  jest.resetModules();
  jest.mock('../src/db', () => mockTestDb);
  jest.mock('@anthropic-ai/sdk', () => {
    return jest.fn().mockImplementation(() => ({
      messages: { create: jest.fn() },
    }));
  });
  assistantService = require('../src/assistantService');
});

const USER_ID = 1;

describe('getNotionEnabled', () => {
  test('по умолчанию возвращает true', () => {
    expect(assistantService.getNotionEnabled(USER_ID)).toBe(true);
  });

  test('возвращает true если notion_enabled = 1', () => {
    assistantService.updateSettings(USER_ID, { notion_enabled: 1 });
    expect(assistantService.getNotionEnabled(USER_ID)).toBe(true);
  });

  test('возвращает false после выключения', () => {
    assistantService.updateSettings(USER_ID, { notion_enabled: 0 });
    expect(assistantService.getNotionEnabled(USER_ID)).toBe(false);
  });

  test('возвращает true после повторного включения', () => {
    assistantService.updateSettings(USER_ID, { notion_enabled: 0 });
    assistantService.updateSettings(USER_ID, { notion_enabled: 1 });
    expect(assistantService.getNotionEnabled(USER_ID)).toBe(true);
  });
});

describe('updateSettings notion_enabled', () => {
  test('notion_enabled входит в список разрешённых полей', () => {
    assistantService.updateSettings(USER_ID, { notion_enabled: 0 });
    const settings = assistantService.getSettings(USER_ID);
    expect(settings.notion_enabled).toBe(0);
  });

  test('другие настройки не затрагиваются при обновлении notion_enabled', () => {
    assistantService.updateSettings(USER_ID, { morning_time: '08:00' });
    assistantService.updateSettings(USER_ID, { notion_enabled: 0 });
    const settings = assistantService.getSettings(USER_ID);
    expect(settings.morning_time).toBe('08:00');
    expect(settings.notion_enabled).toBe(0);
  });
});
