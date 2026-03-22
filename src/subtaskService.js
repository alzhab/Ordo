const db = require('./db');

function getSubtasks(taskId) {
  return db.prepare('SELECT * FROM subtasks WHERE task_id = ? ORDER BY position, id').all(taskId);
}

function createSubtask(taskId, title) {
  const row = db.prepare('SELECT MAX(position) AS m FROM subtasks WHERE task_id = ?').get(taskId);
  const position = (row?.m ?? -1) + 1;
  const result = db.prepare(
    'INSERT INTO subtasks (task_id, title, position) VALUES (?, ?, ?)'
  ).run(taskId, title, position);
  return db.prepare('SELECT * FROM subtasks WHERE id = ?').get(result.lastInsertRowid);
}

function createSubtasks(taskId, titles) {
  const insert = db.prepare('INSERT INTO subtasks (task_id, title, position) VALUES (?, ?, ?)');
  return titles.map((title, i) => {
    const result = insert.run(taskId, title, i);
    return db.prepare('SELECT * FROM subtasks WHERE id = ?').get(result.lastInsertRowid);
  });
}

function updateSubtask(id, fields) {
  const allowed = ['title', 'is_done', 'notion_block_id'];
  const updates = Object.keys(fields).filter(k => allowed.includes(k)).map(k => `${k} = ?`);
  if (updates.length === 0) return db.prepare('SELECT * FROM subtasks WHERE id = ?').get(id);
  db.prepare(`UPDATE subtasks SET ${updates.join(', ')} WHERE id = ?`)
    .run(...Object.values(fields).slice(0, updates.length), id);
  return db.prepare('SELECT * FROM subtasks WHERE id = ?').get(id);
}

function toggleSubtask(id) {
  const sub = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(id);
  if (!sub) return null;
  return updateSubtask(id, { is_done: sub.is_done ? 0 : 1 });
}

function deleteSubtask(id) {
  db.prepare('DELETE FROM subtasks WHERE id = ?').run(id);
}

function getSubtaskById(id) {
  return db.prepare('SELECT * FROM subtasks WHERE id = ?').get(id);
}

function deleteAllSubtasks(taskId) {
  db.prepare('DELETE FROM subtasks WHERE task_id = ?').run(taskId);
}

module.exports = { getSubtasks, getSubtaskById, createSubtask, createSubtasks, updateSubtask, toggleSubtask, deleteSubtask, deleteAllSubtasks };
