const db = require('../connection');

function saveTokens(userId, provider, tokens) {
  db.prepare(`
    INSERT INTO oauth_tokens
      (user_id, provider, access_token, refresh_token, token_type, expiry_date, scope, email, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, provider) DO UPDATE SET
      access_token  = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, refresh_token),
      token_type    = excluded.token_type,
      expiry_date   = excluded.expiry_date,
      scope         = excluded.scope,
      email         = COALESCE(excluded.email, email),
      updated_at    = datetime('now')
  `).run(
    userId, provider,
    tokens.access_token,
    tokens.refresh_token  ?? null,
    tokens.token_type     ?? null,
    tokens.expiry_date    ?? null,
    tokens.scope          ?? null,
    tokens.email          ?? null,
  );
}

function getTokens(userId, provider) {
  return db.prepare('SELECT * FROM oauth_tokens WHERE user_id = ? AND provider = ?').get(userId, provider);
}

function deleteTokens(userId, provider) {
  db.prepare('DELETE FROM oauth_tokens WHERE user_id = ? AND provider = ?').run(userId, provider);
}

module.exports = { saveTokens, getTokens, deleteTokens };
