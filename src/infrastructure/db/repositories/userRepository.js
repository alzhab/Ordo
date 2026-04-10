const db = require('../connection');
const { DEFAULT_CATEGORIES } = require('./categoryRepository');

// Создаёт пользователя если не существует, сразу засеивает дефолтные категории.
// Вызывается из shared/helpers.getUser при каждом сообщении — идемпотентен.
function ensureUser(userId, username) {
  const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!existing) {
    db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run(userId, username ?? null);
    const insert = db.prepare('INSERT OR IGNORE INTO categories (user_id, name) VALUES (?, ?)');
    for (const name of DEFAULT_CATEGORIES) {
      insert.run(userId, name);
    }
  }
}

module.exports = { ensureUser };
