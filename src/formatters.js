const { getSubtasks } = require('./subtaskService');
const { utcToLocal } = require('./helpers');

const STATUS_ICON     = { not_started: '⬜', in_progress: '🔄', done: '✅', waiting: '⏸' };
const PRIORITY_ICON   = { high: '🔴', medium: '🟡', low: '🟢' };
const STATUS_LABEL_RU = { not_started: '⬜ Не начата', in_progress: '🔄 В работе', done: '✅ Готово', waiting: '⏸ В ожидании' };

function formatWaitingUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date().toISOString().split('T')[0];
  const overdue = dateStr < today;
  const [y, m, d] = dateStr.split('-');
  const months = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  return `${overdue ? '⚠️ ' : ''}${parseInt(d)} ${months[parseInt(m) - 1]} ${y}`;
}

function formatTaskText(t, index) {
  const icon     = STATUS_ICON[t.status] ?? '⬜';
  const priority = t.priority ? ` ${PRIORITY_ICON[t.priority]}` : '';
  const cat      = t.category_name ? ` · ${t.category_name}` : '';
  const due      = t.planned_for ? ` · 📅 ${t.planned_for}` : '';
  return `${index}. ${icon}${priority} *${t.title}*${cat}${due}`;
}

function formatTaskDetail(t, timezone) {
  const statusLabel   = { not_started: '⬜ Не начата', in_progress: '🔄 В работе', done: '✅ Готово', waiting: '⏸ В ожидании' };
  const priorityLabel = { high: '🔴 Высокий', medium: '🟡 Средний', low: '🟢 Низкий' };
  const lines = [`📌 *${t.title}*\n`];
  lines.push(`*Статус:* ${statusLabel[t.status] ?? t.status}`);
  if (t.status === 'waiting') {
    if (t.waiting_reason) lines.push(`*Причина:* ${t.waiting_reason}`);
    if (t.waiting_until)  lines.push(`*До:* ${formatWaitingUntil(t.waiting_until)}`);
  }
  if (t.category_name) lines.push(`*Категория:* ${t.category_name}`);
  if (t.priority)      lines.push(`*Приоритет:* ${priorityLabel[t.priority] ?? t.priority}`);
  if (t.planned_for)   lines.push(`*Запланировано:* ${t.planned_for}`);
  if (t.description)   lines.push(`*Описание:* ${t.description}`);
  if (t.goal_title)    lines.push(`*Цель:* ${t.goal_title}`);
  const subtasks = getSubtasks(t.id);
  if (subtasks.length > 0) {
    const done = subtasks.filter(s => s.is_done).length;
    lines.push(`*Шаги:* ${done}/${subtasks.length}`);
  }
  if (t.reminder_at) {
    console.log('[formatTaskDetail] stored reminder_at (UTC):', t.reminder_at, '| timezone:', timezone);
    const display = timezone ? utcToLocal(t.reminder_at, timezone) : t.reminder_at;
    console.log('[formatTaskDetail] display (local):', display);
    const fired = t.reminder_sent ? ' _(отправлено)_' : '';
    lines.push(`*🔔 Напомнить:* ${display.slice(0, 16)}${fired}`);
  }
  if (t.notion_page_id) {
    const url = `https://notion.so/${t.notion_page_id.replace(/-/g, '')}`;
    lines.push(`[Открыть в Notion](${url})`);
  }
  lines.push(`\n_Создана: ${t.created_at.slice(0, 10)}_`);
  return lines.join('\n');
}

function formatPreview(task) {
  if (task.reminder_at) console.log('[formatPreview] reminder_at from Claude:', JSON.stringify(task.reminder_at));
  const lines = ['📝 *Создать задачу?*\n'];
  lines.push(`*Название:* ${task.title}`);
  if (task.description) lines.push(`*Описание:* ${task.description}`);
  lines.push(`*📁 Категория:* ${task.category ?? 'не указана'}`);
  if (task.plannedFor)  lines.push(`*📅 Запланировано:* ${task.plannedFor}`);
  if (task.priority)    lines.push(`*⚡ Приоритет:* ${task.priority}`);
  if (task.goal)        lines.push(`*📎 Цель:* ${task.goal}`);
  if (task.reminder_at) lines.push(`*🔔 Напомнить:* ${task.reminder_at.slice(0, 16)}`);
  if (task.status === 'waiting') {
    lines.push(`*Статус:* ⏸ В ожидании`);
    if (task.waiting_reason) lines.push(`*Причина:* ${task.waiting_reason}`);
    if (task.waiting_until)  lines.push(`*До:* ${task.waiting_until}`);
  }
  if (task.subtasks?.length) {
    lines.push(`\n*📋 Шаги (${task.subtasks.length}):*`);
    task.subtasks.forEach(s => lines.push(`  ☐ ${s}`));
  }
  return lines.join('\n');
}

function formatPlanLine(p) {
  const progress = p.total > 0 ? ` (${p.done}/${p.total})` : ' (0)';
  return `📋 ${p.title}${progress}`;
}

function formatPlanDetail(plan, tasks) {
  const byStatus = { not_started: [], in_progress: [], done: [] };
  for (const t of tasks) byStatus[t.status]?.push(t);

  const lines = [`📋 *${plan.title}*`];
  if (plan.description) lines.push(`_${plan.description}_`);
  lines.push(`\nПрогресс: ${byStatus.done.length}/${tasks.length} завершено\n`);

  if (byStatus.in_progress.length) {
    lines.push('🔄 *В работе:*');
    byStatus.in_progress.forEach(t => lines.push(`  · ${t.title}`));
  }
  if (byStatus.not_started.length) {
    lines.push('⬜ *Не начато:*');
    byStatus.not_started.forEach(t => lines.push(`  · ${t.title}`));
  }
  if (byStatus.done.length) {
    lines.push('✅ *Готово:*');
    byStatus.done.forEach(t => lines.push(`  · ${t.title}`));
  }
  if (tasks.length === 0) lines.push('_Задач нет_');

  return lines.join('\n');
}

function formatPlanSuggestion(parsed) {
  const priIcon = { 'Высокий': '🔴', 'Средний': '🟡', 'Низкий': '🟢' };
  const lines = [`🤖 *Предлагаю план:*\n`, `📋 *${parsed.title}*`];
  if (parsed.description) lines.push(`_${parsed.description}_`);
  lines.push(`\n*Задачи (${parsed.tasks.length}):*`);
  parsed.tasks.forEach((t, i) => {
    let line = `${i + 1}. ${t.title}`;
    if (t.priority) line += ` ${priIcon[t.priority] ?? ''}`;
    if (t.category) line += ` · 📁 ${t.category}`;
    if (t.plannedFor) line += ` · 📅 ${t.plannedFor}`;
    lines.push(line);
  });
  return lines.join('\n');
}

function formatStepsList(task, subtasks) {
  const done     = subtasks.filter(s => s.is_done).length;
  const progress = subtasks.length > 0 ? ` ${done}/${subtasks.length}` : '';
  const lines    = [`📋 *Шаги:${progress}*\n*${task.title}*\n`];
  if (subtasks.length === 0) {
    lines.push('_Шагов нет_');
  } else {
    subtasks.forEach(s => lines.push(`${s.is_done ? '☑' : '☐'} ${s.title}`));
  }
  return lines.join('\n');
}

function formatBatchTaskPreview(task, index, total) {
  const lines = [`📝 *Задача ${index + 1} из ${total}*\n`];
  lines.push(`*Название:* ${task.title}`);
  if (task.description) lines.push(`*Описание:* ${task.description}`);
  lines.push(`*📁 Категория:* ${task.category ?? 'не указана'}`);
  if (task.plannedFor) lines.push(`*📅 Запланировано:* ${task.plannedFor}`);
  if (task.priority)  lines.push(`*⚡ Приоритет:* ${task.priority}`);
  if (task.goal)      lines.push(`*📎 Цель:* ${task.goal}`);
  if (task.status === 'waiting') {
    lines.push(`*Статус:* ⏸ В ожидании`);
    if (task.waiting_reason) lines.push(`*Причина:* ${task.waiting_reason}`);
    if (task.waiting_until)  lines.push(`*До:* ${task.waiting_until}`);
  }
  if (task.subtasks?.length) {
    lines.push(`\n*📋 Шаги (${task.subtasks.length}):*`);
    task.subtasks.forEach(s => lines.push(`  ☐ ${s}`));
  }
  return lines.join('\n');
}

function formatBulkPreview(tasks, action, params) {
  const actionDesc = {
    update_status:   `→ ${STATUS_LABEL_RU[params.status] ?? params.status}`,
    delete:          '→ 🗑 Удалить',
    assign_plan:     `→ 📋 ${params.plan}`,
    assign_category: `→ 📁 ${params.category}`,
    set_priority:    `→ ⚡ ${params.priority}`,
  }[action] ?? '';
  const lines = [`⚡ *Групповое действие* ${actionDesc}\n`, `Затронет *${tasks.length}* задач:\n`];
  tasks.slice(0, 10).forEach((t, i) => lines.push(`${i + 1}. ${t.title}`));
  if (tasks.length > 10) lines.push(`_...и ещё ${tasks.length - 10}_`);
  return lines.join('\n');
}

module.exports = {
  STATUS_ICON, PRIORITY_ICON, STATUS_LABEL_RU,
  formatTaskText, formatTaskDetail, formatWaitingUntil, formatPreview,
  formatPlanLine, formatPlanDetail, formatPlanSuggestion,
  formatStepsList, formatBulkPreview, formatBatchTaskPreview,
};
