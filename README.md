# Ordo — Developer Guide

Telegram-бот для управления задачами голосом и текстом. SQLite локально, опциональная синхронизация с Notion.

---

## Быстрый старт

```bash
git clone <repo> && cd Ordo
npm install
cp .env.example .env   # заполни переменные
npm run dev            # watch mode
npm test               # тесты
```

### .env

```env
TELEGRAM_BOT_TOKEN=        # @BotFather
GROQ_API_KEY=              # console.groq.com — voice → text (бесплатно)
ANTHROPIC_API_KEY=         # console.anthropic.com — парсинг и AI планирование

# Notion (опционально)
NOTION_TOKEN=
NOTION_DATABASE_ID=
NOTION_PLANS_DATABASE_ID=
NOTION_DATABASE_ID_DEV=
NOTION_PLANS_DATABASE_ID_DEV=

DEV=true                   # data_dev.db + dev Notion базы
DATA_DIR=/data             # Railway: путь к volume
```

---

## Архитектура

Проект разбит на 4 слоя. Зависимости идут строго сверху вниз:

```
delivery  →  application  →  infrastructure
   ↘              ↘               ↘
              shared  ←←←←←←←←←←←←←
```

**Правило:** слой знает только о слоях ниже себя. `infrastructure` не импортирует из `application`. `application` не знает про Telegram.

```
src/
├── bot.js                         — точка входа: миграции + запуск бота
│
├── shared/                        — утилиты без зависимостей от слоёв
│   ├── config.js                  — env переменные
│   ├── helpers.js                 — timezone helpers, date parsing, getUser, parseTimeInput
│   ├── fuzzy.js                   — normalize(), fuzzyMatch()
│   └── state.js                   — in-memory диалог (pendingTasks, taskFilters...)
│
├── application/                   — бизнес-логика, без привязки к Telegram
│   ├── tasks.js                   — createTask, saveTask, CRUD, advanceRecurring, cleanupDoneTasks
│   ├── goals.js                   — createGoal, archiveGoal, getGoalsWithProgress
│   ├── subtasks.js                — createSubtask, toggleSubtask, reorderSubtasks
│   ├── categories.js              — ensureUser, getCategories, createCategory
│   ├── settings.js                — getSettings, updateSettings, isQuietMode, getNotionEnabled
│   ├── notifications.js           — logNotification, wasNotifiedToday, syncErrors
│   └── assistant.js               — getPlanRecommendations, getReviewData
│
├── infrastructure/                — внешние сервисы и БД
│   ├── ai/
│   │   ├── claudeClient.js        — ask(prompt), askJson(prompt) через Anthropic API
│   │   ├── parser.js              — текст/голос → JSON намерения (Claude)
│   │   └── whisper.js             — voice file → текст (Groq Whisper)
│   ├── integrations/
│   │   └── notion.js              — sync задач и целей в Notion
│   └── db/
│       ├── connection.js          — SQLite соединение (WAL, FK on)
│       ├── migrations.js          — все CREATE TABLE + ALTER, запускаются при старте
│       └── repositories/
│           ├── taskRepository.js      — чистый SQL: INSERT/SELECT/UPDATE задач
│           ├── goalRepository.js      — SQL целей
│           ├── subtaskRepository.js   — SQL подзадач
│           ├── categoryRepository.js  — SQL категорий
│           └── syncErrorRepository.js — SQL лога ошибок sync
│
└── delivery/telegram/             — всё специфичное для Telegram
    ├── bot.js                     — регистрация команд, handlers, онбординг /start
    ├── scheduler.js               — cron каждую минуту: plan/review/recurring + weekly cleanup
    ├── formatters.js              — объекты → Markdown строки
    ├── keyboards.js               — inline-клавиатуры
    ├── renderers.js               — рендер списков задач с фильтрами
    └── handlers/
        ├── tasks.js               — /tasks, фильтры, CRUD, bulk, waiting
        ├── goals.js               — /goals, CRUD целей
        ├── subtasks.js            — шаги: toggle, add, edit, AI-генерация
        ├── settings.js            — /settings, уведомления, категории, интеграции
        ├── assistant.js           — /plan /review + слайдеры + оба календаря
        └── intent.js              — голос/текст → intent → action
```

---

## Слои подробно

### shared/

Не зависит ни от чего в проекте. Используется всеми слоями.

**`helpers.js`** — основные утилиты:
- `getUser(ctx)` — ensureUser + возвращает userId из Telegram ctx
- `localNow(timezone)` → `"YYYY-MM-DD"` — текущая дата в зоне пользователя
- `localToUtc(localStr, timezone)` / `utcToLocal(utcStr, timezone)` — конвертация для хранения в БД
- `parseFlexibleDate(text, timezone)` — "завтра", "через неделю", "22 марта" → ISO дата
- `parseTimeInput(text)` — "в 8 утра", "21:30", "9" → "HH:MM" или null
- `parseReminderDatetime(text, timezone)` — "через 2 часа", "завтра в 9 утра" → UTC datetime
- `normalizeWaiting(reason, until)` — вытаскивает дату из текста причины если `until` не задан
- `safeEdit`, `safeDelete` — Telegram edit/delete без крашей на "not modified"

**`state.js`** — in-memory хранилище диалогового состояния (Map по userId):
- `pendingTasks` — диалоговые состояния: reviewData, reviewSlider, planData, planSlider, reviewCalTaskId…
- `taskFilters` — текущий фильтр списка задач
- `processingUsers` — защита от дублирования запросов

**`fuzzy.js`** — нечёткий поиск задач по тексту для команды `manage_task`.

---

### application/

Бизнес-логика. Не знает про Telegram, ctx, bot. Возвращает plain objects.

**`tasks.js`** — `createTask(userId, parsed)` содержит логику:
1. Если `parsed.category` — ищет или создаёт категорию
2. Если `parsed.plan` — ищет цель по заголовку
3. Передаёт уже разрешённые `category_id`, `goal_id` в `taskRepository.createTask`

Ключевые функции:
- `snoozeTask(id)` — сбрасывает `updated_at` на сейчас (скрывает из /review на 3 дня)
- `advanceRecurring(id)` — переносит `planned_for` повторяющейся задачи на следующий цикл
- `cleanupDoneTasks()` — soft-delete всех `status='done' AND is_recurring=0`

**`settings.js`** — владеет таблицей `user_settings`. `getSettings` делает upsert. Список `ALLOWED_FIELDS` защищает от случайного UPDATE: `plan_time`, `review_time`, `timezone`, `plan_enabled`, `review_enabled`, `quiet_until`, `notion_enabled`.

**`notifications.js`** — лог уведомлений + sync errors. `wasNotifiedToday` использует timezone пользователя.

**`assistant.js`** — AI use cases:
- `getPlanRecommendations(userId, date)` — async, возвращает `[{id, reason}]` для /plan; повторяющиеся исключены из просроченных
- `getReviewData(userId)` — sync, SQL запросы по 3 категориям (из плана / ожидание / без даты) + doneToday; повторяющиеся исключены из всех категорий

---

### infrastructure/

Чистый доступ к внешним сервисам. Репозитории делают только SQL — никакой логики.

**`ai/claudeClient.js`** — единственная точка создания Anthropic клиента:
```js
ask(prompt, { maxTokens, model })     // → string
askJson(prompt, { maxTokens, model }) // → object (парсит JSON из ответа)
```
Модель по умолчанию: `claude-sonnet-4-6`.

**`ai/parser.js`** — принимает текст пользователя, возвращает JSON намерение. Поддерживает intents:
`create_task`, `create_tasks_batch`, `create_recurring`, `create_recurring_batch`,
`manage_task`, `query_tasks`, `manage_goal`, `manage_tasks_bulk`, `manage_category`, `manage_settings`, `suggest_goal`.

**`db/connection.js`** — открывает SQLite (WAL mode, FK on). Путь: `DATA_DIR/data.db` или `data_dev.db` при `DEV=true`.

**`db/migrations.js`** — все `CREATE TABLE IF NOT EXISTS` и `ALTER TABLE` миграции. Запускается один раз при старте. Безопасно запускать повторно.

**`db/repositories/taskRepository.js`** — ключевые функции помимо CRUD:
- `computeNextOccurrence(recur_days, recur_day_of_month)` — следующая дата срабатывания
- `getRecurringDueNow(hhmm, day, dayOfMonth, userId?)` — повторяющиеся задачи к отправке прямо сейчас
- `advanceRecurring(taskId)` — переносит `planned_for` на следующий цикл
- `snoozeTask(id)` — `UPDATE tasks SET updated_at = datetime('now')`
- `cleanupDoneTasks()` — soft-delete всех выполненных не-повторяющихся задач

---

### delivery/telegram/

Всё что знает про Telegram. Импортирует из `application/` и `shared/`.

**`bot.js`** — регистрирует команды и запускает бот. `/start` определяет новый/возвращающийся пользователь по наличию активных задач.

**`scheduler.js`** — cron каждую минуту. Порядок выполнения:
1. `runWeeklyCleanup()` — воскресенье 02:00 UTC, `cleanupDoneTasks()`
2. Task reminders (`reminder_at` истёк) — отправляет и помечает `reminder_sent = 1`
3. Recurring tasks — `getRecurringDueNow` → отправить с кнопкой `[✅ Сделал]` → `advanceRecurring`
4. `/plan` (`plan_time` совпадает, не отправляли сегодня)
5. `/review` (`review_time` совпадает, не отправляли сегодня)

Активный пользователь = есть задача с `updated_at >= -7 days`.

**`handlers/assistant.js`** — `/plan` и `/review`:
- `handlePlan` → `handlePlanForDate(ctx, date)` — загружает запланированные + AI-рекомендации
- `buildCalendarKeyboard(year, month, options)` — переиспользуемый календарь с настраиваемыми prefixes (используется и в /plan и в /review inbox)
- `/review`: слайдер по 3 категориям; для inbox-категории кнопка `[📅 Выбрать дату]` открывает второй календарь
- State recovery: если `planData`/`reviewData` потеряны (перезапуск бота), восстанавливаются из БД

**`handlers/settings.js`** — `/settings`:
- Главный экран: время plan/review + категорий N + кнопки
- `sn_mt_change` / `sn_et_change` → ставит `state.awaitingSettingInput` → ждёт текст
- Notion вынесен в подраздел `renderIntegrationsSettings`

**`handlers/intent.js`** — центральный роутер голоса/текста:
- Перехватывает `state.awaitingSettingInput` для ввода времени через `parseTimeInput`
- Задачи сохраняются немедленно через `saveTask`, без шага "превью → подтверждение"
- `handleCreateRecurring` / `handleCreateRecurringBatch` — создание повторяющихся задач

---

## База данных

SQLite, файл `data.db` (или `data_dev.db` при `DEV=true`, или `$DATA_DIR/data.db` на Railway).

### Схема

```sql
users             — id (telegram user_id), username
categories        — id, user_id, name, color
goals             — id, user_id, title, description, status (active/archived), notion_page_id
tasks             — id, user_id, title, description,
                    status (todo/waiting/done/deleted),
                    category_id → categories,
                    goal_id → goals,
                    planned_for (DATE),
                    waiting_reason, waiting_until (DATE),
                    reminder_at (DATETIME UTC), reminder_sent (0/1),
                    is_recurring (0/1), recur_days (JSON), recur_day_of_month,
                    recur_time (HH:MM), recur_remind_before (minutes),
                    notion_page_id
subtasks          — id, task_id CASCADE, title, is_done, position, notion_block_id
user_settings     — user_id PK, plan_time, review_time, timezone,
                    plan_enabled, review_enabled, quiet_until, notion_enabled
notification_log  — id, user_id, type ('plan'|'review'), task_id, sent_at, reacted
sync_errors       — id, user_id, message, created_at
```

### Статусы задач

| Статус | Смысл |
|--------|-------|
| `todo` | взял в работу, дефолт при создании |
| `waiting` | жду внешнего события или даты |
| `done` | готово; очищается каждое воскресенье (кроме is_recurring) |
| `deleted` | soft delete |

### Временные зоны

Все datetime в БД хранятся в **UTC**. Конвертация происходит в `shared/helpers.js`. Дефолтная зона: `Asia/Oral` (UTC+5, Казахстан).

---

## Поток создания задачи

```
Пользователь пишет/говорит
  → [голос] whisper.js → текст
  → parser.js (Claude) → { intent: "create_task", title, status, category, ... }
  → handlers/intent.js → saveTask() немедленно
      → резолвинг category_id (создаёт если нет), goal_id
      → taskRepository.createTask() → INSERT
      → показывает "✅ Название — сохранено" с [✏️ Изменить] [🗑 Отменить]
      → [если Notion] notion.js sync в фоне
```

---

## Тестирование

```bash
npm test
```

In-memory SQLite — никаких внешних зависимостей. Claude и Notion мокаются.

```
tests/
├── helpers/
│   ├── db.js          — createTestDb(): полная схема в памяти
│   └── ctx.js         — фейковый Telegram ctx
├── taskService.test.js
├── planService.test.js
├── subtaskService.test.js
├── categoryService.test.js
├── parser.test.js
├── notion.test.js
└── handlers/
    ├── confirm.test.js
    ├── tasks.test.js
    ├── filters.test.js
    ├── plans.test.js
    ├── subtasks.test.js
    ├── waiting.test.js
    └── edit_saved.test.js
```

### Паттерн мока БД в тестах

```js
let mockTestDb;
jest.mock('../src/infrastructure/db/connection', () => mockTestDb);

beforeEach(() => {
  mockTestDb = createTestDb();
  jest.resetModules();
  jest.mock('../src/infrastructure/db/connection', () => mockTestDb);
  service = require('../src/application/tasks');
});
```

`jest.resetModules()` + повторный `jest.mock` нужны чтобы каждый тест получил свежий модуль с чистой БД.

---

## Как добавить новую фичу

### Новая команда (пример: `/stats`)

1. **Repository** (если нужны новые SQL запросы) — добавь функцию в `infrastructure/db/repositories/`
2. **Application** — добавь бизнес-логику в нужный файл `application/`
3. **Handler** — добавь handler в `delivery/telegram/handlers/`
4. **Регистрация** — зарегистрируй команду в `delivery/telegram/bot.js`

### Новый intent (голосовая команда)

1. Добавь intent в промпт `infrastructure/ai/parser.js`
2. Добавь case в `delivery/telegram/handlers/intent.js`

### Новый тип уведомлений

1. Логика в `application/notifications.js` или `application/assistant.js`
2. Отправка в `delivery/telegram/scheduler.js`
3. Тип пишется в `notification_log` — используй `logNotification(userId, 'my_type')`

### Новая платформа (WhatsApp, REST API)

Создай `src/delivery/<platform>/` и используй `application/` напрямую. `infrastructure/` и `shared/` переиспользуются без изменений.

---

## Деплой (Railway)

Тип сервиса: **Worker** (не Web — нет HTTP, нет health check).

```env
DATA_DIR=/data    # Railway Volume — там живёт data.db
```

БД монтируется как volume на `/data`. После деплоя миграции запускаются автоматически.
