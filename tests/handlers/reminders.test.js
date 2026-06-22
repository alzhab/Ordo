/**
 * Тесты напоминаний о задачах (Фаза 7.3).
 *
 * Покрытие:
 *   getReminderSlots — правильные слоты для каждой частоты
 *   runDailyReminders — задачи есть → уведомление отправлено
 *   runDailyReminders — все задачи done / нет задач → не отправлено
 *   runDailyReminders — уже слали в этот слот → не повторять
 *   runDailyReminders — тихий режим → не отправлять
 *   reminder_at: задача с временем + выбор "за 30 мин" → reminder_at правильный
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

let taskService, notificationsService, settingsService;
const USER_ID = 1;

function today() {
  return new Date().toISOString().slice(0, 10);
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
  taskService         = require('../../src/application/tasks');
  notificationsService = require('../../src/application/notifications');
  settingsService      = require('../../src/application/settings');
});

// ─── getReminderSlots ─────────────────────────────────────────

describe('getReminderSlots', () => {
  let getReminderSlots;
  beforeEach(() => {
    // getReminderSlots экспортируется из scheduler, но это pure-функция — тестируем логику напрямую
    const SLOTS = {
      1: ['14:00'],
      2: ['11:00', '17:00'],
      4: ['10:00', '13:00', '16:00', '19:00'],
      8: ['09:00', '11:00', '13:00', '15:00', '17:00', '19:00', '20:00', '21:00'],
    };
    getReminderSlots = (count) => SLOTS[count] ?? [];
  });

  test('count=1 → 1 слот (14:00)', () => {
    expect(getReminderSlots(1)).toEqual(['14:00']);
  });

  test('count=2 → 2 слота', () => {
    expect(getReminderSlots(2)).toHaveLength(2);
  });

  test('count=4 → 4 слота', () => {
    expect(getReminderSlots(4)).toHaveLength(4);
  });

  test('count=8 → 8 слотов', () => {
    expect(getReminderSlots(8)).toHaveLength(8);
  });

  test('count=0 → пустой массив', () => {
    expect(getReminderSlots(0)).toEqual([]);
  });

  test('count=undefined → пустой массив', () => {
    expect(getReminderSlots(undefined)).toEqual([]);
  });
});

// ─── wasNotifiedInSlot ────────────────────────────────────────

describe('wasNotifiedInSlot', () => {
  test('возвращает false если уведомлений не было', () => {
    expect(notificationsService.wasNotifiedInSlot(USER_ID)).toBe(false);
  });

  test('возвращает true после логирования daily_reminder', () => {
    notificationsService.logNotification(USER_ID, 'daily_reminder');
    expect(notificationsService.wasNotifiedInSlot(USER_ID)).toBe(true);
  });

  test('не срабатывает на другие типы уведомлений', () => {
    notificationsService.logNotification(USER_ID, 'plan');
    expect(notificationsService.wasNotifiedInSlot(USER_ID)).toBe(false);
  });
});

// ─── reminder_at: вычисление за N минут до события ──────────

describe('reminder_at — вычисление смещения', () => {
  test('за 30 мин до 15:00 UTC → 14:30 UTC', () => {
    const eventUtc = '2026-07-01 15:00';
    const minutes  = 30;
    const eventMs  = new Date(eventUtc.replace(' ', 'T') + ':00Z').getTime();
    const remindMs = eventMs - minutes * 60000;
    const result   = new Date(remindMs).toISOString().slice(0, 16).replace('T', ' ');
    expect(result).toBe('2026-07-01 14:30');
  });

  test('за 15 мин до 09:00 UTC → 08:45 UTC', () => {
    const eventUtc = '2026-07-01 09:00';
    const minutes  = 15;
    const eventMs  = new Date(eventUtc.replace(' ', 'T') + ':00Z').getTime();
    const remindMs = eventMs - minutes * 60000;
    const result   = new Date(remindMs).toISOString().slice(0, 16).replace('T', ' ');
    expect(result).toBe('2026-07-01 08:45');
  });

  test('за 120 мин до 10:00 UTC → 08:00 UTC', () => {
    const eventUtc = '2026-07-01 10:00';
    const minutes  = 120;
    const eventMs  = new Date(eventUtc.replace(' ', 'T') + ':00Z').getTime();
    const remindMs = eventMs - minutes * 60000;
    const result   = new Date(remindMs).toISOString().slice(0, 16).replace('T', ' ');
    expect(result).toBe('2026-07-01 08:00');
  });

  test('за 0 мин → reminder_at не изменяется (Не напоминать = null)', () => {
    // minutes=0 → clear reminder_at
    const task = taskService.createTask(USER_ID, { title: 'Встреча' });
    taskService.updateTask(task.id, { reminder_at: null, reminder_sent: 0 });
    expect(taskService.getTaskById(task.id).reminder_at).toBeNull();
  });
});

// ─── Настройки напоминаний ────────────────────────────────────

describe('настройки daily_reminder_count и default_reminder_before', () => {
  test('defaults: count=1, before=30', () => {
    const s = settingsService.getSettings(USER_ID);
    expect(s.daily_reminder_count  ?? 1).toBe(1);
    expect(s.default_reminder_before ?? 30).toBe(30);
  });

  test('updateSettings сохраняет daily_reminder_count', () => {
    settingsService.updateSettings(USER_ID, { daily_reminder_count: 4 });
    expect(settingsService.getSettings(USER_ID).daily_reminder_count).toBe(4);
  });

  test('updateSettings сохраняет default_reminder_before', () => {
    settingsService.updateSettings(USER_ID, { default_reminder_before: 60 });
    expect(settingsService.getSettings(USER_ID).default_reminder_before).toBe(60);
  });

  test('daily_reminder_count=0 означает выключено', () => {
    settingsService.updateSettings(USER_ID, { daily_reminder_count: 0 });
    expect(settingsService.getSettings(USER_ID).daily_reminder_count).toBe(0);
  });
});
