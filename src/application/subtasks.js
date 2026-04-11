const subtaskRepo = require('../infrastructure/db/repositories/subtaskRepository');
const taskRepo = require('../infrastructure/db/repositories/taskRepository');
const notion = require('../infrastructure/integrations/notion');
const { getNotionEnabled } = require('./settings');

const {
  getSubtasks,
  getSubtaskById,
  createSubtask,
  createSubtasks,
  updateSubtask,
  toggleSubtask,
  deleteSubtask,
  deleteAllSubtasks,
} = subtaskRepo;

function notionEnabled(userId) {
  return notion.isConfigured() && getNotionEnabled(userId);
}

// Создаёт подзадачу и в фоне синхронизирует с Notion если включено.
async function appendSubtaskWithNotion(userId, taskId, title) {
  const newSub = subtaskRepo.createSubtask(taskId, title);
  if (notionEnabled(userId)) {
    const task = taskRepo.getTaskById(taskId);
    if (task?.notion_page_id) {
      notion.appendSubtaskToNotion(task.notion_page_id, newSub)
        .then(blockId => { if (blockId) subtaskRepo.updateSubtask(newSub.id, { notion_block_id: blockId }); })
        .catch(() => {});
    }
  }
  return newSub;
}

// Обновляет заголовок подзадачи и синхронизирует с Notion если блок привязан.
async function editSubtaskTitleWithNotion(userId, subId, title) {
  const updated = subtaskRepo.updateSubtask(subId, { title });
  if (notionEnabled(userId) && updated.notion_block_id) {
    notion.updateSubtaskBlockTitle(updated.notion_block_id, title).catch(() => {});
  }
  return updated;
}

module.exports = {
  getSubtasks,
  getSubtaskById,
  createSubtask,
  createSubtasks,
  updateSubtask,
  toggleSubtask,
  deleteSubtask,
  deleteAllSubtasks,
  appendSubtaskWithNotion,
  editSubtaskTitleWithNotion,
};
