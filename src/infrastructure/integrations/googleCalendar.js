// Односторонняя синхронизация Ordo → Google Calendar.
// Google Calendar — опциональное зеркало задач с датой.
// Все данные хранятся в SQLite, в Calendar только копия событий.
// Ни одна функция не бросает исключение наружу — ошибки Calendar
// логируются и проглатываются чтобы не ломать основной флоу.

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = require('../../shared/config');
const oauthRepo = require('../db/repositories/oauthRepository');

const PROVIDER    = 'google_calendar';
const TOKEN_URL   = 'https://oauth2.googleapis.com/token';
const CAL_API     = 'https://www.googleapis.com/calendar/v3';
const USERINFO    = 'https://www.googleapis.com/oauth2/v3/userinfo';
const SCOPE       = 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email';

// In-memory OAuth states: state → { userId, createdAt }
// TTL 10 минут — достаточно чтобы пользователь прошёл авторизацию.
const pendingStates = new Map();

function isConfigured() {
  return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI);
}

function generateAuthUrl(userId) {
  const state = `${userId}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  pendingStates.set(state, { userId, createdAt: Date.now() });
  // Очистка истёкших state
  for (const [k, v] of pendingStates) {
    if (Date.now() - v.createdAt > 10 * 60 * 1000) pendingStates.delete(k);
  }
  const params = new URLSearchParams({
    client_id:    GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope:        SCOPE,
    state,
    access_type:  'offline',
    prompt:       'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// Вызывается из HTTP-сервера после редиректа Google.
// Возвращает userId если state валиден, иначе null.
function resolveState(state) {
  const pending = pendingStates.get(state);
  if (!pending) return null;
  pendingStates.delete(state);
  if (Date.now() - pending.createdAt > 10 * 60 * 1000) return null;
  return pending.userId;
}

// Обменивает authorization code на токены и сохраняет их в БД.
async function exchangeCode(userId, code) {
  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri:  GOOGLE_REDIRECT_URI,
      grant_type:    'authorization_code',
      code,
    }),
  });
  const tokens = await res.json();
  if (!res.ok) throw new Error(tokens.error_description ?? tokens.error ?? 'Token exchange failed');

  let email = null;
  try {
    const info = await fetch(USERINFO, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    }).then(r => r.json());
    email = info.email ?? null;
  } catch {}

  oauthRepo.saveTokens(userId, PROVIDER, {
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token ?? null,
    token_type:    tokens.token_type    ?? null,
    expiry_date:   tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
    scope:         tokens.scope         ?? null,
    email,
  });

  return { email };
}

// Возвращает валидный access_token, обновляя его если истёк.
async function getAccessToken(userId) {
  const stored = oauthRepo.getTokens(userId, PROVIDER);
  if (!stored?.access_token) return null;

  // Обновляем токен за 60 секунд до истечения
  if (stored.expiry_date && stored.expiry_date < Date.now() + 60_000) {
    if (!stored.refresh_token) return null;
    try {
      const res = await fetch(TOKEN_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({
          client_id:     GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          grant_type:    'refresh_token',
          refresh_token: stored.refresh_token,
        }),
      });
      const tokens = await res.json();
      if (!res.ok) return null;
      oauthRepo.saveTokens(userId, PROVIDER, {
        ...stored,
        access_token: tokens.access_token,
        expiry_date:  tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
      });
      return tokens.access_token;
    } catch {
      return null;
    }
  }

  return stored.access_token;
}

function isConnected(userId) {
  return !!(oauthRepo.getTokens(userId, PROVIDER)?.access_token);
}

function getConnectedEmail(userId) {
  return oauthRepo.getTokens(userId, PROVIDER)?.email ?? null;
}

function disconnect(userId) {
  oauthRepo.deleteTokens(userId, PROVIDER);
}

// ─── Calendar API ─────────────────────────────────────────────

function taskToEvent(task) {
  const event = { summary: task.title };
  if (task.description) event.description = task.description;
  if (task.planned_for) {
    // All-day event: end date = next day (Google Calendar convention)
    const nextDay = new Date(task.planned_for + 'T00:00:00Z');
    nextDay.setDate(nextDay.getDate() + 1);
    event.start = { date: task.planned_for };
    event.end   = { date: nextDay.toISOString().split('T')[0] };
  }
  return event;
}

async function createEvent(userId, task) {
  if (!task.planned_for) return null;
  const token = await getAccessToken(userId);
  if (!token) return null;

  const res = await fetch(`${CAL_API}/calendars/primary/events`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(taskToEvent(task)),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message ?? `Calendar API ${res.status}`);
  }
  const event = await res.json();
  return event.id;
}

async function updateEvent(userId, gcalEventId, task) {
  if (!gcalEventId) return;
  const token = await getAccessToken(userId);
  if (!token) return;

  await fetch(`${CAL_API}/calendars/primary/events/${gcalEventId}`, {
    method:  'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(taskToEvent(task)),
  });
}

async function deleteEvent(userId, gcalEventId) {
  if (!gcalEventId) return;
  const token = await getAccessToken(userId);
  if (!token) return;

  const res = await fetch(`${CAL_API}/calendars/primary/events/${gcalEventId}`, {
    method:  'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  // 404/410 = уже удалено — это нормально
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message ?? `Calendar API ${res.status}`);
  }
}

// Возвращает события Google Calendar на указанную дату (YYYY-MM-DD).
async function getTodayEvents(userId, dateStr) {
  const token = await getAccessToken(userId);
  if (!token) return [];

  // timeMin/timeMax охватывают весь день включая all-day события
  const timeMin = `${dateStr}T00:00:00Z`;
  const nextDay = new Date(dateStr + 'T00:00:00Z');
  nextDay.setDate(nextDay.getDate() + 1);
  const timeMax = nextDay.toISOString();

  const params = new URLSearchParams({
    timeMin, timeMax,
    singleEvents: 'true',
    orderBy:      'startTime',
    maxResults:   '20',
  });

  const res = await fetch(`${CAL_API}/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];

  const data = await res.json();
  return (data.items ?? []).filter(e => e.status !== 'cancelled');
}

module.exports = {
  isConfigured,
  generateAuthUrl,
  resolveState,
  exchangeCode,
  isConnected,
  getConnectedEmail,
  disconnect,
  createEvent,
  updateEvent,
  deleteEvent,
  getTodayEvents,
};
