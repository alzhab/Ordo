const db = require('../connection');

function addAttachment(taskId, { type, file_id = null, file_name = null, url = null }) {
  const result = db.prepare(`
    INSERT INTO task_attachments (task_id, type, file_id, file_name, url)
    VALUES (?, ?, ?, ?, ?)
  `).run(taskId, type, file_id, file_name, url);
  return db.prepare('SELECT * FROM task_attachments WHERE id = ?').get(result.lastInsertRowid);
}

function getAttachments(taskId) {
  return db.prepare('SELECT * FROM task_attachments WHERE task_id = ? ORDER BY id').all(taskId);
}

function deleteAttachment(id) {
  return db.prepare('DELETE FROM task_attachments WHERE id = ?').run(id);
}

module.exports = { addAttachment, getAttachments, deleteAttachment };
