const { ensureUser } = require('./categoryService');

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
function extractDateFromText(text) {
  if (!text) return null;
  const l = text.toLowerCase();

  const addDays = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().split('T')[0];
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
      const diff = ((day - new Date().getDay()) + 7) % 7 || 7;
      return addDays(diff);
    }
  }

  return null;
}

// Парсинг гибких дат: "через неделю", "завтра", "22 марта", "2026-03-20" → ISO YYYY-MM-DD
function parseFlexibleDate(text) {
  if (!text) return text;
  const t = text.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t; // уже ISO

  const addDays = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().split('T')[0];
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
      const diff = ((day - new Date().getDay()) + 7) % 7 || 7;
      return addDays(diff);
    }
  }

  // "22 марта" / "22 марта 2026"
  const fromRussian = extractDateFromText(t);
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

module.exports = { getUser, safeEdit, safeDelete, parseFlexibleDate, extractDateFromText, normalizeWaiting, extractNotionPageId };
