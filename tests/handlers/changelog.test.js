/**
 * Тесты версионности и changelog (Фаза 7.5).
 *
 * Покрытие:
 *   getNewEntries — нет last_seen → все (макс 3)
 *   getNewEntries — last_seen === current → пусто
 *   getNewEntries — last_seen = старая версия → только новые (макс 3)
 *   last_seen_version сохраняется в настройках
 *   updateSettings принимает last_seen_version
 *   formatChangesBrief — дедупликация и bullet-points
 */

const { createTestDb } = require('../helpers/db');

let mockTestDb;

jest.mock('../../src/infrastructure/integrations/notion', () => ({
  isConfigured: () => false,
}));
jest.mock('../../src/infrastructure/integrations/googleCalendar', () => ({
  isConnected: () => false,
}));

let settingsService;
const USER_ID = 1;

beforeEach(() => {
  mockTestDb = createTestDb();
  jest.resetModules();
  jest.mock('../../src/infrastructure/db/connection', () => mockTestDb);
  jest.mock('../../src/infrastructure/integrations/notion', () => ({
    isConfigured: () => false,
  }));
  jest.mock('../../src/infrastructure/integrations/googleCalendar', () => ({
    isConnected: () => false,
  }));
  settingsService = require('../../src/application/settings');
});

// ─── Хелперы из bot.js вынесены в отдельную логику ───────────
// Тестируем логику напрямую, не через Telegraf

function makeGetNewEntries(changelog) {
  return function getNewEntries(lastSeen) {
    if (!lastSeen) return changelog.slice(0, 3);
    const idx = changelog.findIndex(e => e.version === lastSeen);
    if (idx <= 0) return [];
    return changelog.slice(0, Math.min(idx, 3));
  };
}

function makeFormatChangesBrief() {
  return function formatChangesBrief(entries) {
    const seen  = new Set();
    const lines = [];
    for (const e of entries) {
      for (const c of e.changes) {
        if (!seen.has(c.text)) { seen.add(c.text); lines.push(`• ${c.text}`); }
      }
    }
    return lines.join('\n');
  };
}

const MOCK_CHANGELOG = [
  {
    version: '1.3.0',
    date: '2026-06-22',
    changes: [
      { type: 'new',      text: 'Номера задач' },
      { type: 'improved', text: 'Просроченные задачи переносятся' },
    ],
  },
  {
    version: '1.2.0',
    date: '2026-05-01',
    changes: [
      { type: 'new', text: 'Повторяющиеся задачи' },
    ],
  },
  {
    version: '1.1.0',
    date: '2026-04-01',
    changes: [
      { type: 'new', text: 'Google Calendar интеграция' },
    ],
  },
  {
    version: '1.0.0',
    date: '2026-03-01',
    changes: [
      { type: 'new', text: 'Первый релиз' },
    ],
  },
];

describe('getNewEntries', () => {
  const getNewEntries = makeGetNewEntries(MOCK_CHANGELOG);

  test('last_seen=null → все записи, макс 3', () => {
    const result = getNewEntries(null);
    expect(result).toHaveLength(3);
    expect(result[0].version).toBe('1.3.0');
  });

  test('last_seen=current → пустой массив', () => {
    expect(getNewEntries('1.3.0')).toHaveLength(0);
  });

  test('last_seen=1.2.0 → только 1.3.0', () => {
    const result = getNewEntries('1.2.0');
    expect(result).toHaveLength(1);
    expect(result[0].version).toBe('1.3.0');
  });

  test('last_seen=1.1.0 → 1.3.0 и 1.2.0 (макс 3)', () => {
    const result = getNewEntries('1.1.0');
    expect(result).toHaveLength(2);
    expect(result.map(e => e.version)).toEqual(['1.3.0', '1.2.0']);
  });

  test('last_seen=1.0.0 → 3 записи (макс 3, не 4)', () => {
    const result = getNewEntries('1.0.0');
    expect(result).toHaveLength(3);
  });

  test('last_seen=несуществующая → пустой массив', () => {
    expect(getNewEntries('0.9.0')).toHaveLength(0);
  });
});

describe('formatChangesBrief', () => {
  const formatChangesBrief = makeFormatChangesBrief();

  test('форматирует записи как bullet-points', () => {
    const result = formatChangesBrief([MOCK_CHANGELOG[0]]);
    expect(result).toContain('• Номера задач');
    expect(result).toContain('• Просроченные задачи переносятся');
  });

  test('дедуплицирует одинаковые тексты', () => {
    const entries = [
      { version: '1.3.0', changes: [{ type: 'new', text: 'Фича А' }] },
      { version: '1.2.0', changes: [{ type: 'new', text: 'Фича А' }] },
    ];
    const result = formatChangesBrief(entries);
    expect(result.split('• Фича А').length - 1).toBe(1);
  });

  test('пустой массив → пустая строка', () => {
    expect(formatChangesBrief([])).toBe('');
  });
});

describe('last_seen_version в настройках', () => {
  test('по умолчанию null', () => {
    const s = settingsService.getSettings(USER_ID);
    expect(s.last_seen_version).toBeNull();
  });

  test('updateSettings сохраняет last_seen_version', () => {
    settingsService.updateSettings(USER_ID, { last_seen_version: '1.3.0' });
    expect(settingsService.getSettings(USER_ID).last_seen_version).toBe('1.3.0');
  });

  test('можно обновить на новую версию', () => {
    settingsService.updateSettings(USER_ID, { last_seen_version: '1.2.0' });
    settingsService.updateSettings(USER_ID, { last_seen_version: '1.3.0' });
    expect(settingsService.getSettings(USER_ID).last_seen_version).toBe('1.3.0');
  });
});
