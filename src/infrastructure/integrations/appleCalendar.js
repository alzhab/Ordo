const oauthRepo = require('../db/repositories/oauthRepository');

const PROVIDER   = 'apple_calendar';
const CALDAV_URL = 'https://caldav.icloud.com';
const BYDAY      = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function authHeader(email, password) {
  return 'Basic ' + Buffer.from(`${email}:${password}`).toString('base64');
}

// Extracts href values from CalDAV PROPFIND XML
function extractHrefs(xml) {
  const re = /<(?:[a-zA-Z]+:)?href[^>]*>([^<]+)<\/(?:[a-zA-Z]+:)?href>/gi;
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) results.push(m[1].trim());
  return results;
}

// Extract first href inside a specific property element (by local name)
function extractPropHref(xml, propLocalName) {
  // Match the property element (with or without namespace prefix)
  const propRe = new RegExp(`<(?:[a-zA-Z]+:)?${propLocalName}[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z]+:)?${propLocalName}>`, 'i');
  const m = propRe.exec(xml);
  if (!m) return null;
  const inner = m[1];
  const hrefRe = /<(?:[a-zA-Z]+:)?href[^>]*>([^<]+)<\/(?:[a-zA-Z]+:)?href>/i;
  const hm = hrefRe.exec(inner);
  return hm ? hm[1].trim() : null;
}

function fullUrl(href) {
  if (!href) return null;
  return href.startsWith('http') ? href : `${CALDAV_URL}${href}`;
}

async function propfind(url, body, auth, depth = '0') {
  const res = await fetch(url, {
    method:  'PROPFIND',
    headers: {
      Authorization:  auth,
      'Content-Type': 'application/xml; charset=utf-8',
      Depth:          depth,
    },
    body,
  });
  if (res.status === 401) throw new Error('Неверный Apple ID или пароль приложения. Убедись что используешь app-specific password, а не основной пароль.');
  const text = await res.text();
  if (!res.ok && res.status !== 207) throw new Error(`CalDAV ${res.status}`);
  return text;
}

async function discoverAndSave(userId, email, password) {
  const auth = authHeader(email, password);

  // Step 1: current-user-principal
  const xml1 = await propfind(CALDAV_URL, `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop><D:current-user-principal/></D:prop>
</D:propfind>`, auth, '0');

  const principalHref = extractPropHref(xml1, 'current-user-principal');
  if (!principalHref) throw new Error('Не удалось получить principal URL. Проверь Apple ID.');
  const principalUrl = fullUrl(principalHref);

  // Step 2: calendar-home-set
  const xml2 = await propfind(principalUrl, `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><C:calendar-home-set/></D:prop>
</D:propfind>`, auth, '0');

  const homeHref = extractPropHref(xml2, 'calendar-home-set');
  if (!homeHref) throw new Error('Не удалось найти calendar-home-set. Проверь настройки iCloud Calendar.');
  const homeUrl = fullUrl(homeHref);

  // Step 3: list calendars, find first real one
  const xml3 = await propfind(homeUrl, `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:resourcetype/><D:displayname/></D:prop>
</D:propfind>`, auth, '1');

  // Split by response elements, skip non-calendar ones
  const blocks = xml3.split(/<\/(?:[a-zA-Z]+:)?response>/i);
  let calendarUrl = null;
  for (const block of blocks) {
    // Must have calendar resourcetype
    if (!/<(?:[a-zA-Z]+:)?calendar[\s/>]/i.test(block)) continue;
    // Skip special collections
    if (/inbox|outbox|schedule|notification|dropbox/i.test(block)) continue;
    const href = extractHrefs(block)[0];
    if (href && href !== homeHref && href !== homeUrl.replace(CALDAV_URL, '')) {
      calendarUrl = fullUrl(href);
      break;
    }
  }

  if (!calendarUrl) throw new Error('Не найдено ни одного iCloud Calendar. Убедись что у тебя есть хотя бы один календарь в iCloud.');

  oauthRepo.saveTokens(userId, PROVIDER, {
    access_token: password,
    email,
    scope: calendarUrl,
  });

  return { email, calendarUrl };
}

function isConnected(userId) {
  const t = oauthRepo.getTokens(userId, PROVIDER);
  return !!(t?.access_token && t?.scope);
}

function getConnectedEmail(userId) {
  return oauthRepo.getTokens(userId, PROVIDER)?.email ?? null;
}

function getCalendarUrl(userId) {
  return oauthRepo.getTokens(userId, PROVIDER)?.scope ?? null;
}

function disconnect(userId) {
  oauthRepo.deleteTokens(userId, PROVIDER);
}

// iCal text escaping: \, ; , \n
function esc(str) {
  if (!str) return '';
  return String(str).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function dtStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
}

function buildRRule(task) {
  if (task.recur_day_of_month) return `RRULE:FREQ=MONTHLY;BYMONTHDAY=${task.recur_day_of_month}`;
  const days = task.recur_days
    ? (typeof task.recur_days === 'string' ? JSON.parse(task.recur_days) : task.recur_days)
    : null;
  if (!days || days.length === 0) return 'RRULE:FREQ=DAILY';
  return `RRULE:FREQ=WEEKLY;BYDAY=${days.map(d => BYDAY[d]).join(',')}`;
}

function addHour(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const total  = h * 60 + m + 60;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// Returns null if task has no planned_for
function buildIcal(task, timezone, uid) {
  if (!task.planned_for) return null;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Ordo//Ordo Task Manager//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtStamp()}`,
  ];

  if (task.is_recurring && task.recur_time && task.planned_for) {
    const dateStr = task.planned_for.replace(/-/g, '');
    const timeStr = task.recur_time.replace(':', '') + '00';
    const endStr  = addHour(task.recur_time).replace(':', '') + '00';
    lines.push(`DTSTART;TZID=${timezone}:${dateStr}T${timeStr}`);
    lines.push(`DTEND;TZID=${timezone}:${dateStr}T${endStr}`);
    lines.push(buildRRule(task));
  } else if (task.reminder_at && task.planned_for) {
    const start = new Date(task.reminder_at);
    const end   = new Date(start.getTime() + 60 * 60 * 1000);
    lines.push(`DTSTART:${start.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`);
    lines.push(`DTEND:${end.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`);
  } else {
    const dateStr = task.planned_for.replace(/-/g, '');
    const nextDay = new Date(task.planned_for + 'T00:00:00Z');
    nextDay.setDate(nextDay.getDate() + 1);
    const nextStr = nextDay.toISOString().split('T')[0].replace(/-/g, '');
    lines.push(`DTSTART;VALUE=DATE:${dateStr}`);
    lines.push(`DTEND;VALUE=DATE:${nextStr}`);
  }

  lines.push(`SUMMARY:${esc(task.title)}`);
  if (task.description) lines.push(`DESCRIPTION:${esc(task.description)}`);
  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');

  return lines.join('\r\n');
}

async function createEvent(userId, task, timezone = 'UTC') {
  if (!task.planned_for) return null;
  const tokens = oauthRepo.getTokens(userId, PROVIDER);
  if (!tokens?.access_token || !tokens?.scope) return null;

  const uid  = `ordo-${task.id}-${Math.random().toString(36).slice(2, 8)}@ordo`;
  const ical = buildIcal(task, timezone, uid);
  if (!ical) return null;

  const auth = authHeader(tokens.email, tokens.access_token);
  const res = await fetch(`${tokens.scope}${uid}.ics`, {
    method:  'PUT',
    headers: {
      Authorization:  auth,
      'Content-Type': 'text/calendar; charset=utf-8',
      'If-None-Match': '*',
    },
    body: ical,
  });

  if (res.status === 401) throw new Error('Ошибка аутентификации iCloud Calendar.');
  if (!res.ok && res.status !== 201 && res.status !== 204) {
    throw new Error(`CalDAV ${res.status}`);
  }

  return uid;
}

async function updateEvent(userId, uid, task, timezone = 'UTC') {
  if (!uid) return;
  const tokens = oauthRepo.getTokens(userId, PROVIDER);
  if (!tokens?.access_token || !tokens?.scope) return;

  const ical = buildIcal(task, timezone, uid);
  if (!ical) return;

  const auth = authHeader(tokens.email, tokens.access_token);
  await fetch(`${tokens.scope}${uid}.ics`, {
    method:  'PUT',
    headers: {
      Authorization:  auth,
      'Content-Type': 'text/calendar; charset=utf-8',
    },
    body: ical,
  });
}

async function deleteEvent(userId, uid) {
  if (!uid) return;
  const tokens = oauthRepo.getTokens(userId, PROVIDER);
  if (!tokens?.access_token || !tokens?.scope) return;

  const auth = authHeader(tokens.email, tokens.access_token);
  const res = await fetch(`${tokens.scope}${uid}.ics`, {
    method:  'DELETE',
    headers: { Authorization: auth },
  });

  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`CalDAV ${res.status}`);
  }
}

module.exports = { isConnected, getConnectedEmail, getCalendarUrl, discoverAndSave, disconnect, createEvent, updateEvent, deleteEvent };
