const db = require('../infrastructure/db/connection');

const ALLOWED_FIELDS = ['plan_time', 'review_time', 'timezone', 'plan_enabled', 'review_enabled', 'quiet_until', 'notion_enabled'];

function getSettings(userId) {
  let row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId);
  if (!row) {
    db.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)').run(userId);
    row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId);
  }
  return row;
}

function updateSettings(userId, fields) {
  const keys = Object.keys(fields).filter(k => ALLOWED_FIELDS.includes(k));
  if (!keys.length) return;
  getSettings(userId); // ensure row exists
  const sets = keys.map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE user_settings SET ${sets}, updated_at = datetime('now') WHERE user_id = ?`)
    .run(...keys.map(k => fields[k]), userId);
}

function getNotionEnabled(userId) {
  return getSettings(userId).notion_enabled !== 0;
}

function isQuietMode(userId) {
  const { quiet_until } = getSettings(userId);
  return quiet_until ? new Date(quiet_until) > new Date() : false;
}

module.exports = { getSettings, updateSettings, getNotionEnabled, isQuietMode };
