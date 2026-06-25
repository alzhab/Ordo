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

function findByAliceUserId(aliceUserId) {
  return db.prepare('SELECT * FROM users WHERE alice_user_id = ?').get(aliceUserId) ?? null;
}

function setAliceUserId(userId, aliceUserId) {
  db.prepare('UPDATE users SET alice_user_id = ? WHERE id = ?').run(aliceUserId, userId);
}

function getAliceUserId(userId) {
  return db.prepare('SELECT alice_user_id FROM users WHERE id = ?').get(userId)?.alice_user_id ?? null;
}

module.exports = { ensureUser, findByAliceUserId, setAliceUserId, getAliceUserId };
