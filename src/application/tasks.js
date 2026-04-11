const taskRepo = require('../infrastructure/db/repositories/taskRepository');
const { getCategoryByName, createCategory } = require('../infrastructure/db/repositories/categoryRepository');
const { getGoalByTitle } = require('../infrastructure/db/repositories/goalRepository');
const subtaskRepo = require('../infrastructure/db/repositories/subtaskRepository');
const notion = require('../infrastructure/integrations/notion');
const { logSyncError } = require('./notifications');
const { getNotionEnabled } = require('./settings');

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
  const updated = taskRepo.updateTask(id, fields);

  if (!userId || !isNotionEnabled(userId) || !updated.notion_page_id) return updated;

  const syncable = Object.keys(fields).filter(k => !NO_SYNC_FIELDS.has(k));
  if (syncable.length === 0) return updated;

  const hasStatus = 'status' in fields;
  const hasOtherFields = syncable.some(k => k !== 'status');
  const isWaiting = fields.status === 'waiting';

  if (hasStatus) {
    notion.updateTaskStatus(updated.notion_page_id, updated.status)
      .catch(e => logSyncError(userId, `Статус "${updated.title}": ${e.message}`));
  }

  // Синкаем поля если изменились не-статусные поля, или статус стал waiting
  // (нужно передать waiting_reason/waiting_until в Notion)
  if (hasOtherFields || isWaiting) {
    notion.updateTaskFields(updated.notion_page_id, updated).catch(() => {});
  }

  return updated;
}

// Soft delete + архивирует страницу в Notion
function deleteTask(id, userId = null) {
  const task = taskRepo.getTaskById(id);
  const deleted = taskRepo.updateTask(id, { status: 'deleted' });
  if (userId && isNotionEnabled(userId) && task?.notion_page_id) {
    notion.updateTaskStatus(task.notion_page_id, 'deleted').catch(() => {});
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
  getDueReminders,
} = taskRepo;

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
  getDueReminders,
  syncAllTasks,
};
