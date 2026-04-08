const { ensureUser } = require('./categoryService');

// ─── Timezone helpers ─────────────────────────────────────────

// Разбирает дату/время через formatToParts — безопасно независимо от локали и разделителей
function _intlParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const p = {};
  for (const { type, value } of parts) p[type] = value;
  // hour12:false может давать "24" для полуночи — нормализуем
  const h = parseInt(p.hour) === 24 ? 0 : parseInt(p.hour);
  return {
    year: parseInt(p.year), month: parseInt(p.month), day: parseInt(p.day),
    hour: h, minute: parseInt(p.minute),
  };
}

// Текущая дата в локальном часовом поясе пользователя → "YYYY-MM-DD"
function localNow(timezone) {
  if (!timezone) return new Date().toISOString().slice(0, 10);
  const { year, month, day } = _intlParts(new Date(), timezone);
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

// UTC строка "YYYY-MM-DD HH:MM" → локальное время пользователя "YYYY-MM-DD HH:MM"
function utcToLocal(utcStr, timezone) {
  if (!utcStr || !timezone) return utcStr;
  const [datePart, timePart = '00:00'] = utcStr.split(' ');
  const d = new Date(`${datePart}T${timePart}:00Z`);
  const { year, month, day, hour, minute } = _intlParts(d, timezone);
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')} ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
}

// Локальное время "YYYY-MM-DD HH:MM" → UTC строка "YYYY-MM-DD HH:MM" для хранения в БД
function localToUtc(localStr, timezone) {
  if (!localStr || !timezone) return localStr;
  const [datePart, timePart = '09:00'] = localStr.split(' ');
  // Probe: treat localStr as UTC to compute timezone offset at that date
  const probe = new Date(`${datePart}T${timePart}:00Z`);
  const { year: ply, month: plm, day: pld, hour: plh, minute: plmi } = _intlParts(probe, timezone);
  const probeLocalMs = Date.UTC(ply, plm - 1, pld, plh, plmi);
  const offsetMs = probeLocalMs - probe.getTime();
  const [dy, dmo, dd] = datePart.split('-').map(Number);
  const [dh, dm] = timePart.split(':').map(Number);
  const desiredLocalMs = Date.UTC(dy, dmo - 1, dd, dh, dm);
  return new Date(desiredLocalMs - offsetMs).toISOString().slice(0, 16).replace('T', ' ');
}

function getUser(ctx) {
  const { id, username } = ctx.from;
  ensureUser(id, username);
  return id;
}

// Безопасное editMessageText — игнорирует "message is not modified" и "message to edit not found"
async function safeEdit(ctx, text, opts = {}) {
  try {
    return await ctx.editMessageText(text, opts);
  } catch (e) {
    if (e.description?.includes('message is not modified')) return;
    if (e.description?.includes('message to edit not found')) return;
    throw e;
  }
}

// Безопасное deleteMessage — игнорирует "message to delete not found"
async function safeDelete(ctx) {
  try {
    return await ctx.deleteMessage();
  } catch (e) {
    if (e.description?.includes('message to delete not found')) return;
    if (e.description?.includes("can't be deleted")) return;
    throw e;
  }
}

const RUSSIAN_MONTH_MAP = {
  января: 0, февраля: 1, марта: 2, апреля: 3, мая: 4,
  июня: 5, июля: 6, августа: 7, сентября: 8, октября: 9,
  ноября: 10, декабря: 11,
};

// Ищет любое упоминание даты где угодно в строке, возвращает ISO или null.
// Обрабатывает: "22 марта", "завтра", "послезавтра", "через неделю",
// "через N дней/недель", дни недели, ISO-дату.
function extractDateFromText(text, timezone) {
  if (!text) return null;
  const l = text.toLowerCase();

  const addDays = (n) => {
    const base = localNow(timezone);
    const d = new Date(`${base}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  // ISO дата
  const iso = l.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];

  // "DD MMMM [YYYY]"
  const monthRe = /(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+(\d{4}))?/;
  const mm = l.match(monthRe);
  if (mm) {
    const day   = parseInt(mm[1]);
    const month = RUSSIAN_MONTH_MAP[mm[2]];
    const now   = new Date();
    let year    = mm[3] ? parseInt(mm[3]) : now.getFullYear();
    if (!mm[3] && new Date(year, month, day) < now) year++;
    return new Date(year, month, day).toISOString().split('T')[0];
  }

  // Точные слова
  if (/\bсегодня\b/.test(l))      return addDays(0);
  if (/\bзавтра\b/.test(l))       return addDays(1);
  if (/\bпослезавтра\b/.test(l))  return addDays(2);

  // "через N дней/недель/месяцев"
  const daysM  = l.match(/через\s+(\d+)\s+дн/);
  if (daysM)  return addDays(parseInt(daysM[1]));
  const weeksM = l.match(/через\s+(\d+)\s+нед/);
  if (weeksM) return addDays(parseInt(weeksM[1]) * 7);

  // "через неделю / две недели / месяц"
  if (/через\s+(одну\s+)?неделю/.test(l))                         return addDays(7);
  if (/через\s+(две|2)\s+недели/.test(l))                         return addDays(14);
  if (/через\s+месяц/.test(l))                                    return addDays(30);

  // Дни недели
  const weekdays = { понедельник: 1, вторник: 2, среду: 3, среда: 3, четверг: 4, пятницу: 5, пятница: 5, субботу: 6, суббота: 6, воскресенье: 0 };
  for (const [name, day] of Object.entries(weekdays)) {
    if (l.includes(name)) {
      const base = localNow(timezone);
      const baseDay = new Date(`${base}T00:00:00Z`).getUTCDay();
      const diff = ((day - baseDay) + 7) % 7 || 7;
      return addDays(diff);
    }
  }

  return null;
}

// Парсинг гибких дат: "через неделю", "завтра", "22 марта", "2026-03-20" → ISO YYYY-MM-DD
function parseFlexibleDate(text, timezone) {
  if (!text) return text;
  const t = text.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t; // уже ISO

  const addDays = (n) => {
    const base = localNow(timezone);
    const d = new Date(`${base}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  const l = t.toLowerCase();
  if (l === 'сегодня') return addDays(0);
  if (l === 'завтра') return addDays(1);
  if (l === 'послезавтра') return addDays(2);
  if (l === 'через неделю') return addDays(7);
  if (l === 'через две недели' || l === 'через 2 недели') return addDays(14);
  if (l === 'через месяц') return addDays(30);

  const daysMatch = l.match(/через (\d+) дн/);
  if (daysMatch) return addDays(parseInt(daysMatch[1]));

  const weeksMatch = l.match(/через (\d+) нед/);
  if (weeksMatch) return addDays(parseInt(weeksMatch[1]) * 7);

  const weekdays = { понедельник: 1, вторник: 2, среда: 3, среду: 3, четверг: 4, пятница: 5, пятницу: 5, суббота: 6, субботу: 6, воскресенье: 0 };
  for (const [name, day] of Object.entries(weekdays)) {
    if (l.includes(name)) {
      const base = localNow(timezone);
      const baseDay = new Date(`${base}T00:00:00Z`).getUTCDay();
      const diff = ((day - baseDay) + 7) % 7 || 7;
      return addDays(diff);
    }
  }

  // "22 марта" / "22 марта 2026"
  const fromRussian = extractDateFromText(t, timezone);
  if (fromRussian) return fromRussian;

  return null;
}

// Извлечь Notion page ID из URL или raw ID
// Поддерживает: полный URL, UUID с дефисами, 32 hex символа без дефисов
function extractNotionPageId(input) {
  const str = input.trim();
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(str)) {
    return str.toLowerCase();
  }
  const noDashes = str.replace(/-/g, '');
  const match = noDashes.match(/([a-f0-9]{32})(?:\?|#|$)/i);
  if (!match) return null;
  const id = match[1].toLowerCase();
  return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
}

// Нормализует поля ожидания: если waiting_until не задан но в reason есть дата — берёт её.
function normalizeWaiting(waiting_reason, waiting_until) {
  const reason = waiting_reason ?? null;
  let until    = waiting_until ?? null;
  if (!until && reason) {
    until = extractDateFromText(reason) ?? null;
  }
  return { waiting_reason: reason, waiting_until: until };
}

// Конвертирует reminder_at из Claude-парсера в UTC строку для БД.
// Если значение "через N минут/часов" — вычисляет серверное время (точно).
// Иначе считает значение локальным временем и конвертирует через localToUtc.
function parserReminderToUtc(reminderAt, timezone) {
  if (!reminderAt) return null;
  const isRelative = /^через\s+\d+\s+(минут|минуту|минуты|час|часа|часов)/i.test(reminderAt);
  let result;
  if (isRelative) {
    result = parseReminderDatetime(reminderAt, timezone);
  } else {
    result = localToUtc(reminderAt, timezone);
  }
  return result;
}

// Парсит дату+время напоминания из текста, возвращает UTC строку для хранения в БД.
// timezone — IANA-зона пользователя (напр. "Asia/Oral"). Без timezone сохраняет как есть.
// Поддерживает: "2026-03-29 14:00", "29 марта 14:00", "завтра в 9 утра", "через 2 часа"
function parseReminderDatetime(text, timezone) {
  if (!text) return null;
  const t = text.trim();

  // Уже ISO datetime: "2026-03-29 14:00" или "2026-03-29T14:00" — считаем локальным, конвертируем
  const isoMatch = t.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  if (isoMatch) return localToUtc(`${isoMatch[1]} ${isoMatch[2]}`, timezone);

  // "через N часов/минут" — относительное, сразу UTC
  const hoursMatch = t.match(/через (\d+) час/i);
  if (hoursMatch) {
    const d = new Date(Date.now() + parseInt(hoursMatch[1]) * 3600000);
    return `${d.toISOString().slice(0, 10)} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
  }
  const minsMatch = t.match(/через (\d+) мин/i);
  if (minsMatch) {
    const d = new Date(Date.now() + parseInt(minsMatch[1]) * 60000);
    return `${d.toISOString().slice(0, 10)} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
  }

  // Ищем время в тексте: "14:00", "в 9 утра", "в 21:00"
  let timeStr = null;
  const colonTime = t.match(/\b(\d{1,2}):(\d{2})\b/);
  if (colonTime) {
    timeStr = `${colonTime[1].padStart(2,'0')}:${colonTime[2]}`;
  } else {
    const morningMatch = t.match(/в (\d{1,2}) утра/i);
    const eveningMatch = t.match(/в (\d{1,2}) вечера/i) || t.match(/в (\d{1,2}) ночи/i);
    if (morningMatch) timeStr = `${morningMatch[1].padStart(2,'0')}:00`;
    else if (eveningMatch) {
      const h = parseInt(eveningMatch[1]);
      timeStr = `${String(h < 12 ? h + 12 : h).padStart(2,'0')}:00`;
    }
  }

  const date = parseFlexibleDate(t, timezone);
  if (date && timeStr) return localToUtc(`${date} ${timeStr}`, timezone);
  if (date) return localToUtc(`${date} 09:00`, timezone);
  if (timeStr) {
    const today = localNow(timezone);
    return localToUtc(`${today} ${timeStr}`, timezone);
  }

  return null;
}

module.exports = {
  getUser, safeEdit, safeDelete,
  localNow, utcToLocal, localToUtc, parserReminderToUtc,
  parseFlexibleDate, extractDateFromText, normalizeWaiting, extractNotionPageId, parseReminderDatetime,
};
