const { Client } = require('@notionhq/client');
const { NOTION_TOKEN, NOTION_DATABASE_ID, NOTION_PLANS_DATABASE_ID } = require('../config');

const PRIORITY_LABEL = { high: 'Высокий', medium: 'Средний', low: 'Низкий' };

function logNotionError(fn, e) {
  if (e?.status === 429 || e?.code === 'rate_limited') {
    console.warn(`[Notion] rate limit hit in ${fn} — retry after ${e?.headers?.['retry-after'] ?? '?'}s`);
  } else if (e?.code === 'validation_error' && (e?.message?.includes('does not exist') || e?.message?.includes('is not a property'))) {
    console.warn(`[Notion] ${fn}: поле или опция не найдена в базе — ${e.message}`);
  } else {
    console.error(`[Notion] ${fn} error:`, e?.message ?? e);
  }
}

const isConfigured = () => !!(NOTION_TOKEN && NOTION_DATABASE_ID);
const isPlansConfigured = () => !!(NOTION_TOKEN && NOTION_PLANS_DATABASE_ID);

const notion = new Client({ auth: NOTION_TOKEN, notionVersion: '2022-06-28' });

// task — запись из SQLite (taskService.getTaskById)
async function pushTask(task) {
  if (!isConfigured()) return null;

  const properties = {
    Name: { title: [{ text: { content: task.title } }] },
    Status: { status: { name: 'Not started' } },
    Category: { select: { name: task.category_name ?? 'Общее' } },
  };

  if (task.description) {
    properties.Description = { rich_text: [{ text: { content: task.description } }] };
  }
  if (task.planned_for) {
    properties['Due Date'] = { date: { start: task.planned_for } };
  }
  if (task.priority) {
    properties.Priority = { select: { name: PRIORITY_LABEL[task.priority] ?? task.priority } };
  }
  if (task.plan_notion_page_id) {
    properties.Plan = { relation: [{ id: task.plan_notion_page_id }] };
  }
  if (task.waiting_reason) {
    properties['Waiting Reason'] = { rich_text: [{ text: { content: task.waiting_reason } }] };
  }
  if (task.waiting_until) {
    properties['Waiting Until'] = { date: { start: task.waiting_until } };
  }

  try {
    const page = await notion.pages.create({
      parent: { database_id: NOTION_DATABASE_ID },
      properties,
    });
    return page.id;
  } catch (e) {
    logNotionError('pushTask', e);
    return null;
  }
}

// Обновить поля задачи в Notion (task — полная запись из getTaskById)
async function updateTaskFields(notionPageId, task) {
  if (!isConfigured() || !notionPageId) return;

  const properties = {
    Name: { title: [{ text: { content: task.title } }] },
    Category: { select: { name: task.category_name ?? 'Общее' } },
  };

  if (task.description) {
    properties.Description = { rich_text: [{ text: { content: task.description } }] };
  }
  if (task.planned_for) {
    properties['Due Date'] = { date: { start: task.planned_for } };
  }
  if (task.priority) {
    properties.Priority = { select: { name: PRIORITY_LABEL[task.priority] ?? task.priority } };
  }
  if (task.plan_notion_page_id) {
    properties.Plan = { relation: [{ id: task.plan_notion_page_id }] };
  } else if (!task.plan_id) {
    properties.Plan = { relation: [] };
  }
  if (task.waiting_reason) {
    properties['Waiting Reason'] = { rich_text: [{ text: { content: task.waiting_reason } }] };
  } else {
    properties['Waiting Reason'] = { rich_text: [] };
  }
  if (task.waiting_until) {
    properties['Waiting Until'] = { date: { start: task.waiting_until } };
  } else {
    properties['Waiting Until'] = { date: null };
  }

  try {
    await notion.pages.update({ page_id: notionPageId, properties });
  } catch (e) {
    logNotionError('updateTaskFields', e);
  }
}

const NOTION_STATUS = {
  not_started: 'Not started',
  in_progress: 'In progress',
  waiting:     'Waiting',
  done:        'Done',
  deleted:     'Deleted',
};

async function updateTaskStatus(notionPageId, status) {
  if (!isConfigured() || !notionPageId) return;
  if (status === 'deleted') {
    await archiveNotionPage(notionPageId);
    return;
  }
  try {
    await notion.pages.update({
      page_id: notionPageId,
      properties: {
        Status: { status: { name: NOTION_STATUS[status] ?? 'Not started' } },
      },
    });
  } catch (e) {
    logNotionError('updateTaskStatus', e);
  }
}

// ─── Планы ───────────────────────────────────────────────

async function pushPlan(plan) {
  if (!isPlansConfigured()) return null;
  const properties = {
    Name: { title: [{ text: { content: plan.title } }] },
  };
  try {
    const page = await notion.pages.create({
      parent: { database_id: NOTION_PLANS_DATABASE_ID },
      properties,
    });
    return page.id;
  } catch (e) {
    logNotionError('pushPlan', e);
    return null;
  }
}

async function updatePlanFields(notionPageId, plan) {
  if (!isPlansConfigured() || !notionPageId) return;
  const properties = {
    Name: { title: [{ text: { content: plan.title } }] },
  };
  try {
    await notion.pages.update({ page_id: notionPageId, properties });
  } catch (e) {
    logNotionError('updatePlanFields', e);
  }
}

async function archiveNotionPage(notionPageId) {
  if (!notionPageId) return;
  try {
    const page = await notion.pages.retrieve({ page_id: notionPageId });
    if (page.archived) return; // уже архивирован
    await notion.pages.update({ page_id: notionPageId, archived: true });
  } catch (e) {
    logNotionError('archiveNotionPage', e);
  }
}

async function unarchiveNotionPage(notionPageId) {
  if (!notionPageId) return;
  try {
    await notion.pages.update({ page_id: notionPageId, archived: false });
  } catch (e) {
    logNotionError('unarchiveNotionPage', e);
    throw e;
  }
}

// Полная перезапись блоков + возвращает [{subtaskId, blockId}] для сохранения
async function syncSubtasksToNotion(notionPageId, subtasks) {
  if (!isConfigured() || !notionPageId) return [];

  // Удалить существующие дочерние блоки
  try {
    const existing = await notion.blocks.children.list({ block_id: notionPageId });
    for (const block of existing.results) {
      await notion.blocks.delete({ block_id: block.id });
    }
  } catch {}

  if (subtasks.length === 0) return [];

  const response = await notion.blocks.children.append({
    block_id: notionPageId,
    children: subtasks.map(s => ({
      type: 'to_do',
      to_do: {
        rich_text: [{ type: 'text', text: { content: s.title } }],
        checked: s.is_done === 1,
      },
    })),
  });

  // Вернуть маппинг subtaskId → blockId
  return response.results.map((block, i) => ({
    subtaskId: subtasks[i].id,
    blockId: block.id,
  }));
}

// Обновить галочку конкретного блока
async function toggleSubtaskInNotion(notionBlockId, isDone) {
  if (!isConfigured() || !notionBlockId) return;
  await notion.blocks.update({
    block_id: notionBlockId,
    to_do: { checked: isDone === 1 },
  });
}

// Добавить одну подзадачу как блок, вернуть blockId
async function appendSubtaskToNotion(notionPageId, subtask) {
  if (!isConfigured() || !notionPageId) return null;
  const response = await notion.blocks.children.append({
    block_id: notionPageId,
    children: [{
      type: 'to_do',
      to_do: {
        rich_text: [{ type: 'text', text: { content: subtask.title } }],
        checked: false,
      },
    }],
  });
  return response.results[0]?.id ?? null;
}

async function updateSubtaskBlockTitle(notionBlockId, title) {
  if (!isConfigured() || !notionBlockId) return;
  await notion.blocks.update({
    block_id: notionBlockId,
    to_do: { rich_text: [{ type: 'text', text: { content: title } }] },
  });
}

async function deleteNotionBlock(notionBlockId) {
  if (!isConfigured() || !notionBlockId) return;
  await notion.blocks.delete({ block_id: notionBlockId });
}

module.exports = { pushTask, updateTaskFields, updateTaskStatus, isConfigured, pushPlan, updatePlanFields, archiveNotionPage, unarchiveNotionPage, isPlansConfigured, syncSubtasksToNotion, toggleSubtaskInNotion, appendSubtaskToNotion, updateSubtaskBlockTitle, deleteNotionBlock };
