const taskRepo = require('../infrastructure/db/repositories/taskRepository');
const { getCategoryByName, createCategory } = require('../infrastructure/db/repositories/categoryRepository');
const { getGoalByTitle } = require('../infrastructure/db/repositories/goalRepository');
const subtaskRepo = require('../infrastructure/db/repositories/subtaskRepository');
const notion = require('../infrastructure/integrations/notion');
const gcal  = require('../infrastructure/integrations/googleCalendar');
const { logSyncError } = require('./notifications');
const { getNotionEnabled, getSettings, getGcalColors } = require('./settings');

// Экспортируется для handlers — нужен для UI (показать кнопку "привязать к Notion")
function isNotionEnabled(userId) {
  return notion.isConfigured() && getNotionEnabled(userId);
}

// Резолвит category_id и goal_id из текстовых полей, вставляет задачу в БД.
// Вызывается из saveTask и напрямую когда Notion sync не нужен.
function createTask(userId, parsed) {
  let categoryId = null;
  if (parsed.category) {
    let cat = getCategoryByName(userId, parsed.category);
    if (!cat) cat = createCategory(userId, parsed.category);
    categoryId = cat.id;
  }

  let goalId = parsed.goal_id ?? parsed.plan_id ?? null;
  if (!goalId && parsed.plan) {
    const goal = getGoalByTitle(userId, parsed.plan);
    goalId = goal?.id ?? null;
  }

  return taskRepo.createTask(userId, {
    ...parsed,
    category_id: categoryId,
    goal_id: goalId,
  });
}

// Создаёт задачу + подзадачи + запускает Notion sync в фоне (fire-and-forget).
// Возвращает задачу сразу, не дожидаясь Notion — notion_page_id появится позже.
function saveTask(userId, parsed) {
  const saved = createTask(userId, parsed);

  if (parsed.subtasks?.length) {
    subtaskRepo.createSubtasks(saved.id, parsed.subtasks);
  }

  if (isNotionEnabled(userId)) {
    notion.pushTask(saved)
      .then(async notionPageId => {
        if (!notionPageId) return;
        taskRepo.updateTask(saved.id, { notion_page_id: notionPageId });
        if (saved.status === 'waiting') {
          notion.updateTaskStatus(notionPageId, 'waiting').catch(() => {});
        }
        if (parsed.subtasks?.length) {
          const subtasks = subtaskRepo.getSubtasks(saved.id);
          const mapping = await notion.syncSubtasksToNotion(notionPageId, subtasks);
          mapping.forEach(({ subtaskId, blockId }) => subtaskRepo.updateSubtask(subtaskId, { notion_block_id: blockId }));
        }
      })
      .catch(e => logSyncError(userId, `Создание "${saved.title}": ${e.message}`));
  }

  if (saved.planned_for && gcal.isConnected(userId)) {
    const { timezone } = getSettings(userId);
    const colors = getGcalColors(userId);
    gcal.createEvent(userId, saved, timezone, colors)
      .then(eventId => { if (eventId) taskRepo.updateTask(saved.id, { gcal_event_id: eventId }); })
      .catch(e => logSyncError(userId, `Calendar "${saved.title}": ${e.message}`));
  }

  return saved;
}

// Поля которые не синхронизируются с Notion
const NO_SYNC_FIELDS = new Set(['notion_page_id', 'reminder_sent', 'reminder_at']);

// Обновляет задачу в БД и синкает в Notion если передан userId.
// Без userId — чистое обновление БД (планировщик, внутренние операции).
//
// Логика sync:
//   status изменился → updateTaskStatus
//   другие поля изменились ИЛИ status стал 'waiting' → updateTaskFields
function updateTask(id, fields, userId = null) {
  const before  = userId ? taskRepo.getTaskById(id) : null;
  const updated = taskRepo.updateTask(id, fields);

  // ─── Notion sync ─────────────────────────────────────────────
  if (userId && isNotionEnabled(userId) && updated.notion_page_id) {
    const syncable = Object.keys(fields).filter(k => !NO_SYNC_FIELDS.has(k));
    if (syncable.length > 0) {
      const hasStatus     = 'status' in fields;
      const hasOtherFields = syncable.some(k => k !== 'status');
      const isWaiting     = fields.status === 'waiting';
      if (hasStatus) {
        notion.updateTaskStatus(updated.notion_page_id, updated.status)
          .catch(e => logSyncError(userId, `Статус "${updated.title}": ${e.message}`));
      }
      if (hasOtherFields || isWaiting) {
        notion.updateTaskFields(updated.notion_page_id, updated).catch(() => {});
      }
    }
  }

  // ─── Google Calendar sync ─────────────────────────────────────
  if (userId && gcal.isConnected(userId)) {
    const isTerminal     = ['done', 'deleted'].includes(fields.status);
    const isWaiting      = fields.status === 'waiting';
    const isReactivated  = fields.status === 'todo';
    const plannedChanged = 'planned_for' in fields;
    // Поля влияющие на тип события в Calendar: all_day ↔ timed ↔ recurring
    const typeChanged    = 'reminder_at' in fields || 'is_recurring' in fields ||
                           'recur_days' in fields || 'recur_day_of_month' in fields || 'recur_time' in fields;
    const contentChanged = 'title' in fields || 'description' in fields;
    const gcalEventId    = before?.gcal_event_id ?? null;

    const { timezone } = getSettings(userId);
    const colors = getGcalColors(userId);

    if ((isTerminal || isWaiting) && gcalEventId) {
      // Задача завершена/удалена/waiting — удаляем событие из календаря
      gcal.deleteEvent(userId, gcalEventId).catch(() => {});
      taskRepo.updateTask(id, { gcal_event_id: null });
    } else if (plannedChanged) {
      if (!fields.planned_for && gcalEventId) {
        // Дата снята — удаляем событие
        gcal.deleteEvent(userId, gcalEventId).catch(() => {});
        taskRepo.updateTask(id, { gcal_event_id: null });
      } else if (fields.planned_for && gcalEventId) {
        // Для повторяющихся задач: RRULE в Google Calendar сам управляет датами,
        // поэтому при автосдвиге через advanceRecurring не обновляем серию.
        // Для обычных задач: обновляем событие если дата изменена вручную.
        if (!updated.is_recurring) {
          gcal.updateEvent(userId, gcalEventId, updated, timezone, colors).catch(() => {});
        }
      } else if (fields.planned_for && !gcalEventId) {
        // Дата добавлена впервые — создаём событие или серию
        gcal.createEvent(userId, updated, timezone, colors)
          .then(eid => { if (eid) taskRepo.updateTask(id, { gcal_event_id: eid }); })
          .catch(e => logSyncError(userId, `Calendar "${updated.title}": ${e.message}`));
      }
    } else if ((contentChanged || typeChanged) && gcalEventId) {
      // Название, описание или тип события изменились — пересобираем событие в Calendar
      gcal.updateEvent(userId, gcalEventId, updated, timezone, colors).catch(() => {});
    } else if ((typeChanged || isReactivated) && !gcalEventId && updated.planned_for) {
      // reminder_at добавлен без события, или задача возвращена в todo после done/waiting —
      // создаём событие если задача имеет дату
      gcal.createEvent(userId, updated, timezone, colors)
        .then(eid => { if (eid) taskRepo.updateTask(id, { gcal_event_id: eid }); })
        .catch(e => logSyncError(userId, `Calendar "${updated.title}": ${e.message}`));
    }
  }

  return updated;
}

// Soft delete + архивирует страницу в Notion + удаляет событие из Google Calendar
function deleteTask(id, userId = null) {
  const task    = taskRepo.getTaskById(id);
  const deleted = taskRepo.updateTask(id, { status: 'deleted' });
  if (userId && isNotionEnabled(userId) && task?.notion_page_id) {
    notion.updateTaskStatus(task.notion_page_id, 'deleted').catch(() => {});
  }
  if (userId && task?.gcal_event_id && gcal.isConnected(userId)) {
    gcal.deleteEvent(userId, task.gcal_event_id).catch(() => {});
  }
  return deleted;
}

// Синхронизирует все задачи без notion_page_id с Notion.
// Возвращает { synced, failed } для отображения результата пользователю.
async function syncAllTasks(userId) {
  const tasks = taskRepo.getUnsyncedTasks(userId);
  let synced = 0;
  let failed = 0;
  for (const task of tasks) {
    try {
      const notionPageId = await notion.pushTask(task);
      if (notionPageId) {
        taskRepo.updateTask(task.id, { notion_page_id: notionPageId });
        synced++;
      }
    } catch (e) {
      logSyncError(userId, `Bulk sync "${task.title}": ${e.message}`);
      failed++;
    }
  }
  return { synced, failed };
}

const {
  getTaskById,
  getTasks,
  getTasksByPlannedDate,
  getTasksByGoal,
  getTasksByPlan,
  getUnsyncedTasks,
  getUnsyncedCalendarTasks,
  getSyncedCalendarTasksByType,
  getDueReminders,
  getRecurringDueNow,
  advanceRecurring,
  snoozeTask,
  cleanupDoneTasks,
} = taskRepo;

// Обновляет цвет уже синхронизированных событий одного типа в Google Calendar.
// Вызывается fire-and-forget при изменении цвета в настройках.
async function syncColorForType(userId, type, colors) {
  const tasks = getSyncedCalendarTasksByType(userId, type);
  const { timezone } = getSettings(userId);
  for (const task of tasks) {
    await gcal.updateEvent(userId, task.gcal_event_id, task, timezone, colors).catch(() => {});
  }
}

// Синхронизирует все задачи с датой без gcal_event_id в Google Calendar.
// Возвращает { synced, failed, skipped } для отображения результата пользователю.
async function syncAllToCalendar(userId) {
  const tasks = getUnsyncedCalendarTasks(userId);
  const { timezone } = getSettings(userId);
  const colors = getGcalColors(userId);
  let synced = 0, failed = 0;
  for (const task of tasks) {
    try {
      const eventId = await gcal.createEvent(userId, task, timezone, colors);
      if (eventId) {
        taskRepo.updateTask(task.id, { gcal_event_id: eventId });
        synced++;
      }
    } catch (e) {
      logSyncError(userId, `Calendar bulk "${task.title}": ${e.message}`);
      failed++;
    }
  }
  return { synced, failed, total: tasks.length };
}


module.exports = {
  isNotionEnabled,
  createTask,
  saveTask,
  getTaskById,
  getTasks,
  getTasksByPlannedDate,
  getTasksByGoal,
  getTasksByPlan,
  updateTask,
  deleteTask,
  getUnsyncedTasks,
  getUnsyncedCalendarTasks,
  syncAllToCalendar,
  syncColorForType,
  getDueReminders,
  getRecurringDueNow,
  advanceRecurring,
  snoozeTask,
  cleanupDoneTasks,
  syncAllTasks,
};
