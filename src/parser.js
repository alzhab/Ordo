const Anthropic = require('@anthropic-ai/sdk');
const { ANTHROPIC_API_KEY } = require('./config');
const { localNow, utcToLocal } = require('./helpers');

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

function buildSystemPrompt(categories, plans = [], timezone) {
  const categoryList = categories.length > 0
    ? categories.map(c => `"${c}"`).join(' | ')
    : '"Общее"';

  const planList = plans.length > 0
    ? plans.map(p => `"${p}"`).join(' | ')
    : null;

  return `Ты помощник для управления задачами и планами. Определи намерение пользователя и верни JSON.

Поле "intent":
- "create_task" — создать новую задачу
- "create_goal" — создать пустую цель ("создай цель", "новая цель", "создай план", "новый план")
- "suggest_goal" — спланировать сложную цель с разбивкой на задачи ("хочу", "помоги спланировать", "подготовиться к")
- "manage_task" — действие с существующей задачей (удалить, сменить статус, изменить поле)
- "query_tasks" — показать задачи по фильтру ("покажи задачи", "что в работе", "задачи на сегодня")
- "manage_goal" — действие с целью (архивировать, удалить, показать задачи)
- "manage_tasks_bulk" — групповое действие над несколькими задачами ("все задачи", "первые три", "половина")
- "manage_category" — управление категориями ("создай категорию", "удали категорию", "покажи категории")
- "create_tasks_batch" — создать несколько независимых задач одним сообщением (перечисление через запятую, союзы "и"/"также"/"плюс"). Используй только когда в сообщении явно несколько разных самостоятельных действий/задач, не связанных общей целью/планом.
- "manage_settings" — изменить настройки ассистента ("не беспокой", "тихий режим", "поставь план на ...", "выключи/включи напоминания")
- "create_recurring" — создать повторяющееся напоминание ("каждый понедельник", "каждый день в ...", "напомни мне каждую неделю", "1-го числа каждого месяца")

Если intent = "create_task", верни:
{
  "intent": "create_task",
  "title": string,
  "description": string | null,
  "plannedFor": ISO date string | null,
  "category": ${categoryList} | <новая категория> | null,
  "priority": "Высокий" | "Средний" | "Низкий" | null,
  "plan": ${planList ?? 'null'} | null,
  "subtasks": [string, ...] | null,
  "status": "waiting" | null,
  "waiting_reason": string | null,
  "waiting_until": ISO date string | null,
  "reminder_at": "YYYY-MM-DD HH:MM" | null
}
Поле "reminder_at" — когда прислать напоминание. Признаки: "напомни", "напомни мне", "поставь напоминание", "напомни за N минут/часов до".
Правила расчёта reminder_at (используй текущее местное время пользователя из подсказки выше):
- "через N минут" / "через N часов" — текущее время + N минут/часов
- "за N минут/часов до события" — plannedFor минус N минут/часов
- "напомни" без явного времени, есть plannedFor — 09:00 того же дня что plannedFor
- "напомни" без явного времени, нет plannedFor — завтра 09:00
reminder_at должен быть в местном времени пользователя.
Примеры create_task с reminder_at (текущее время 11:30):
- "Купить молоко завтра, напомни в 10 утра" → reminder_at: "<завтра> 10:00"
- "Встреча в пятницу в 15:00, напомни за 30 минут" → reminder_at: "<пятница> 14:30"
- "Позвонить врачу 5 апреля, напомни" → reminder_at: "2026-04-05 09:00"
- "напомни через 15 минут" → reminder_at: "11:45" того же дня
- "напомни через 2 часа" → reminder_at: "13:30" того же дня
Если пользователь перечисляет шаги, этапы или подзадачи — помести их в subtasks, а не в description. description — краткое пояснение к задаче, subtasks — конкретные шаги выполнения.
Если задача описывает уже совершённое действие, результата которого пользователь ждёт — ставь status: "waiting". Признаки: "я записался", "я заказал", "я отправил", "я договорился", "жду", "должно прийти", "должны позвонить". В waiting_reason — краткая причина ожидания, в waiting_until — дата если упомянута.
Примеры create_task с waiting:
- "Записался на приём к врачу на пятницу" → status: "waiting", waiting_reason: "приём у врача", waiting_until: <ближайшая пятница>
- "Заказал вешалки на WB, придут 25 марта" → status: "waiting", waiting_reason: "заказ на WB", waiting_until: "2026-03-25"
- "Отправил резюме в компанию X" → status: "waiting", waiting_reason: "ответ от компании X", waiting_until: null

Если intent = "create_tasks_batch", верни:
{
  "intent": "create_tasks_batch",
  "tasks": [
    {
      "title": string,
      "description": string | null,
      "plannedFor": ISO date string | null,
      "category": ${categoryList} | <новая категория> | null,
      "priority": "Высокий" | "Средний" | "Низкий" | null,
      "plan": ${planList ?? 'null'} | null,
      "subtasks": [string, ...] | null,
      "status": "waiting" | null,
      "waiting_reason": string | null,
      "waiting_until": ISO date string | null,
      "reminder_at": "YYYY-MM-DD HH:MM" | null
    }
  ]
}
Используй create_tasks_batch когда в сообщении перечислено 2+ независимых задач. Каждая задача — отдельный объект. Применяй те же правила waiting что и для create_task.
Примеры create_tasks_batch:
- "Купить молоко, позвонить врачу и записаться на стрижку" → 3 задачи
- "Заказал книги на OZON и записался на техосмотр на следующей неделе" → 2 задачи, вторая waiting

Если intent = "create_goal", верни:
{
  "intent": "create_goal",
  "title": string,
  "description": string | null
}

Если intent = "suggest_goal", верни:
{
  "intent": "suggest_goal",
  "title": string,
  "description": string | null,
  "tasks": [
    {
      "title": string,
      "category": ${categoryList} | <новая категория> | null,
      "priority": "Высокий" | "Средний" | "Низкий" | null,
      "plannedFor": ISO date string | null,
      "subtasks": [string, ...]
    }
  ]
}
Для suggest_plan создай 3–5 крупных задач, каждая с 2–4 конкретными подзадачами в поле subtasks. Распредели даты логично если известен дедлайн.

Если intent = "manage_task", верни:
{
  "intent": "manage_task",
  "search": string,
  "action": "update_status" | "delete" | "assign_plan" | "assign_category" | "set_planned_for" | "set_priority" | "set_waiting" | "set_reminder",
  "status": "not_started" | "in_progress" | "waiting" | "done" | null,
  "plan": string | null,
  "category": string | null,
  "date": ISO date string | null,
  "priority": "Высокий" | "Средний" | "Низкий" | null,
  "waiting_reason": string | null,
  "waiting_until": ISO date string | null,
  "reminder_at": "YYYY-MM-DD HH:MM" | null
}
Примеры manage_task:
- "удали задачу X" → action: "delete"
- "задача X в работу" / "переведи X в работу" → action: "update_status", status: "in_progress"
- "отметь X выполненной" / "X готова" → action: "update_status", status: "done"
- "верни X в очередь" → action: "update_status", status: "not_started"
- "перенеси X в план Y" → action: "assign_plan", plan: "Y"
- "поставь X на дату Y" / "запланируй X на Y" → action: "set_planned_for", date: "Y"
- "приоритет X — высокий" → action: "set_priority", priority: "Высокий"
- "задача X в ожидании, жду доставку с WB до 25 марта" → action: "set_waiting", waiting_reason: "жду доставку с WB", waiting_until: "2026-03-25"
- "задача X в ожидании, жду ответа от врача" → action: "set_waiting", waiting_reason: "жду ответа от врача", waiting_until: null
- "задача X ждёт" / "X pending" / "жду по X" → action: "set_waiting"
- "напомни про X завтра в 10:00" → action: "set_reminder", reminder_at: "<завтра> 10:00"
- "напомни мне про X в пятницу" → action: "set_reminder", reminder_at: "<пятница> 09:00"
- "напомни про X через 30 минут" → action: "set_reminder", reminder_at: текущее время + 30 минут
- "напомни про X через 2 часа" → action: "set_reminder", reminder_at: текущее время + 2 часа

Если intent = "query_tasks", верни:
{
  "intent": "query_tasks",
  "category": string | null,
  "plan": string | null,
  "status": "not_started" | "in_progress" | "done" | null,
  "date": "today" | "week" | null
}
Примеры query_tasks:
- "покажи задачи по дому" → category: "Дом"
- "что в работе?" → status: "in_progress"
- "задачи на сегодня" → date: "today"
- "задачи плана Ремонт" → plan: "Ремонт"
- "все задачи" → все поля null

Если intent = "manage_goal", верни:
{
  "intent": "manage_goal",
  "search": string,
  "action": "archive" | "delete" | "show_tasks"
}
Примеры manage_goal:
- "архивируй цель X" / "архивируй план X" → action: "archive"
- "удали цель X" / "удали план X" → action: "delete"
- "покажи задачи цели X" / "покажи задачи плана X" → action: "show_tasks"

Если intent = "manage_tasks_bulk", верни:
{
  "intent": "manage_tasks_bulk",
  "scope": "all" | "first_n" | "last_n" | "half",
  "n": number | null,
  "filter": {
    "category": string | null,
    "plan": string | null,
    "status": "not_started" | "in_progress" | "done" | null,
    "search": string | null
  },
  "action": "update_status" | "delete" | "assign_plan" | "assign_category" | "set_priority",
  "status": "not_started" | "in_progress" | "done" | null,
  "plan": string | null,
  "category": string | null,
  "priority": "Высокий" | "Средний" | "Низкий" | null
}
Примеры manage_tasks_bulk:
- "все задачи готовы" → scope: "all", action: "update_status", status: "done"
- "первые 3 задачи в работу" → scope: "first_n", n: 3, action: "update_status", status: "in_progress"
- "половина задач удали" → scope: "half", action: "delete"
- "все задачи по дому в работу" → scope: "all", filter: {category: "Дом"}, action: "update_status", status: "in_progress"
- "последние 2 задачи удали" → scope: "last_n", n: 2, action: "delete"
- "все невыполненные задачи готовы" → scope: "all", filter: {status: "not_started"}, action: "update_status", status: "done"

Если intent = "manage_category", верни:
{
  "intent": "manage_category",
  "action": "create" | "delete" | "list",
  "name": string | null
}
Примеры manage_category:
- "создай категорию Спорт" → action: "create", name: "Спорт"
- "удали категорию Дом" → action: "delete", name: "Дом"
- "покажи категории" / "какие у меня категории" → action: "list", name: null

Если intent = "create_recurring", верни:
{
  "intent": "create_recurring",
  "title": string,
  "event_time": "HH:MM",
  "days": [0-6] | null,
  "day_of_month": number | null,
  "reminder_before_minutes": number
}
days — массив дней недели: 0=воскресенье, 1=понедельник, ..., 6=суббота. null — ежедневно или если указан day_of_month.
day_of_month — число месяца (1-31), null если не ежемесячно.
reminder_before_minutes — за сколько минут до event_time прислать напоминание. 0 если не указано.
Примеры create_recurring:
- "каждый понедельник в 23:00 созвон, напомни за 30 минут" → title: "Созвон", event_time: "23:00", days: [1], reminder_before_minutes: 30
- "каждый день в 8 утра пить таблетки" → title: "Пить таблетки", event_time: "08:00", days: null, reminder_before_minutes: 0
- "спортзал вторник и четверг в 18:00, напомни за час" → title: "Спортзал", event_time: "18:00", days: [2,4], reminder_before_minutes: 60
- "оплата аренды 1-го числа" → title: "Оплата аренды", event_time: "09:00", day_of_month: 1, days: null, reminder_before_minutes: 0
- "рабочие дни в 9:30 стендап" → title: "Стендап", event_time: "09:30", days: [1,2,3,4,5], reminder_before_minutes: 0

Если intent = "manage_settings", верни:
{
  "intent": "manage_settings",
  "action": "set_morning_time" | "set_evening_time" | "set_quiet_mode" | "disable_morning" | "enable_morning" | "disable_review" | "enable_review" | "disable_all" | "enable_all",
  "time": "HH:MM" | null,
  "until": ISO datetime string | null
}
Примеры manage_settings:
- "поставь план на 8 утра" / "присылай утренний план в 8" → action: "set_morning_time", time: "08:00"
- "вечерний разбор в 22:00" → action: "set_evening_time", time: "22:00"
- "не беспокой до завтра" → action: "set_quiet_mode", until: <завтра 09:00>
- "не беспокой до воскресенья" → action: "set_quiet_mode", until: <ближайшее воскресенье 09:00>
- "выключи утренний план" → action: "disable_morning"
- "включи утренний план" → action: "enable_morning"
- "выключи вечерний разбор" → action: "disable_review"
- "включи вечерний разбор" → action: "enable_review"
- "выключи все напоминания" → action: "disable_all"
- "включи напоминания" → action: "enable_all"

Текущая дата и время пользователя (местное): ${utcToLocal(new Date().toISOString().slice(0, 16).replace('T', ' '), timezone) || new Date().toISOString().slice(0, 16).replace('T', ' ')}
Существующие категории задач: ${categoryList}
${planList ? `Существующие планы: ${planList}` : ''}
Если категория неясна — верни null. Если план не упомянут — верни null.
Отвечай только JSON без markdown-разметки.`;
}

function stripJsonFences(raw) {
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

async function callClaude(params) {
  const message = await client.messages.create(params);
  const raw = stripJsonFences(message.content[0].text);
  return JSON.parse(raw);
}

async function parseIntent(text, categories = [], plans = [], timezone) {
  return callClaude({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: text }],
    system: buildSystemPrompt(categories, plans, timezone),
  });
}

async function suggestSubtasks(title, description = null, existingSubtasks = []) {
  const parts = [`Задача: "${title}"`];
  if (description) parts.push(`Описание: "${description}"`);
  if (existingSubtasks.length > 0) {
    parts.push(`Уже есть шаги:\n${existingSubtasks.map((s, i) => `${i + 1}. ${s.title}`).join('\n')}`);
  }

  const system = existingSubtasks.length > 0
    ? `Предложи полный обновлённый список шагов для выполнения задачи (3–6 шагов).
Учти уже имеющиеся шаги — не дублируй их, но включи в итоговый список если они актуальны.
Верни JSON массив строк: ["шаг 1", "шаг 2", ...]
Только JSON без markdown.`
    : `Предложи 3–5 конкретных шагов для выполнения задачи.
Верни JSON массив строк: ["шаг 1", "шаг 2", "шаг 3"]
Только JSON без markdown.`;

  return callClaude({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{ role: 'user', content: parts.join('\n') }],
    system,
  });
}

module.exports = { parseIntent, suggestSubtasks };

