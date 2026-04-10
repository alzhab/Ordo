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
│   ├── helpers.js                 — timezone helpers, date parsing, getUser
│   ├── fuzzy.js                   — normalize(), fuzzyMatch()
│   └── state.js                   — in-memory диалог (pendingTasks, taskFilters...)
│
├── application/                   — бизнес-логика, без привязки к Telegram
│   ├── tasks.js                   — createTask (с резолвингом категории/цели), CRUD
│   ├── goals.js                   — createGoal, archiveGoal, getGoalsWithProgress
│   ├── subtasks.js                — createSubtask, toggleSubtask, reorderSubtasks
│   ├── categories.js              — ensureUser, getCategories, createCategory
│   ├── settings.js                — getSettings, updateSettings, isQuietMode, getNotionEnabled
│   ├── notifications.js           — logNotification, wasNotifiedToday, recurring, syncErrors
│   └── assistant.js               — getMorningPlan, getReviewTasks, getFocusTask, getProgress
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
│           ├── categoryRepository.js  — SQL категорий + PRIORITY_MAP
│           ├── recurringRepository.js — SQL повторяющихся задач
│           └── syncErrorRepository.js — SQL лога ошибок sync
│
└── delivery/telegram/             — всё специфичное для Telegram
    ├── bot.js                     — регистрация команд и handlers, запуск
    ├── scheduler.js               — cron каждую минуту: утро/вечер/напоминания
    ├── formatters.js              — объекты → Markdown строки
    ├── keyboards.js               — inline-клавиатуры
    ├── renderers.js               — рендер списков задач
    └── handlers/
        ├── tasks.js               — /tasks, фильтры, CRUD, bulk, waiting
        ├── goals.js               — /plans, CRUD целей
        ├── subtasks.js            — шаги: toggle, add, edit, AI-генерация
        ├── settings.js            — /settings, категории, Notion
        ├── assistant.js           — /morning /review /focus /progress /reminders
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
- `parseReminderDatetime(text, timezone)` — "через 2 часа", "завтра в 9 утра" → UTC datetime
- `normalizeWaiting(reason, until)` — вытаскивает дату из текста причины если `until` не задан
- `safeEdit`, `safeDelete` — Telegram edit/delete без крашей на "not modified"

**`state.js`** — in-memory хранилище диалогового состояния (Map по userId):
- `pendingTasks` — задачи ожидающие подтверждения
- `taskFilters` — текущий фильтр списка
- `taskPlanContext` — контекст выбора плана при создании задачи
- `processingUsers` — защита от дублирования (пользователь уже обрабатывается)

**`fuzzy.js`** — нечёткий поиск задач по тексту для команды `manage_task`.

---

### application/

Бизнес-логика. Не знает про Telegram, ctx, bot. Возвращает plain objects.

**`tasks.js`** — `createTask(userId, parsed)` содержит логику:
1. Если `parsed.category` — ищет или создаёт категорию
2. Если `parsed.plan` — ищет цель по заголовку
3. Передаёт уже разрешённые `category_id`, `goal_id` в `taskRepository.createTask`

Остальные методы — тонкие обёртки над репозиторием.

**`settings.js`** — владеет таблицей `user_settings`. `getSettings` делает upsert (создаёт строку если нет). Список разрешённых полей защищает от случайного UPDATE.

**`notifications.js`** — лог уведомлений + повторяющиеся задачи + sync errors. `wasNotifiedToday` использует timezone пользователя для сравнения дат.

**`assistant.js`** — AI use cases:
- `getMorningPlan` — async, возвращает `[{id, reason}]` — задачи для плана на день
- `getReviewTasks` — sync, SQL запросы по 5 категориям (план/waiting/stale/maybe), max 5 задач
- `getFocusTask` — async, возвращает `{id, reason}` — одна задача прямо сейчас
- `getProgress` — sync, статистика за день и неделю

---

### infrastructure/

Чистый доступ к внешним сервисам. Репозитории делают только SQL — никакой логики.

**`ai/claudeClient.js`** — единственная точка создания Anthropic клиента:
```js
ask(prompt, { maxTokens, model })     // → string
askJson(prompt, { maxTokens, model }) // → object (парсит JSON из ответа)
```
Модель по умолчанию: `claude-sonnet-4-6`.

**`ai/parser.js`** — принимает текст пользователя, возвращает JSON намерение:
```js
{ intent: "create_task", title: "...", status: "waiting", waiting_until: "...", ... }
```

**`db/connection.js`** — открывает SQLite (WAL mode, FK on). Путь: `DATA_DIR/data.db` или `data_dev.db` при `DEV=true`.

**`db/migrations.js`** — все `CREATE TABLE IF NOT EXISTS` и `ALTER TABLE` миграции. Запускается один раз при старте через `src/bot.js`. Безопасно запускать повторно.

**`db/repositories/`** — чистый SQL, нет зависимостей друг на друга кроме `categoryRepository` (содержит `PRIORITY_MAP`).

---

### delivery/telegram/

Всё что знает про Telegram. Импортирует из `application/` и `shared/`.

**`bot.js`** — регистрирует команды (`/start`, `/tasks`, `/morning`...) и callback handlers. Запускает бот:
```js
bot.launch().catch(err => console.error('[fatal]', err.message));
// Важно: bot.launch() в Telegraf 4.x НИКОГДА не резолвится — scheduler.start() вызывается сразу после
schedulerTask = scheduler.start(bot);
```

**`scheduler.js`** — cron каждую минуту. Для каждого активного пользователя проверяет:
1. Task reminders (`reminder_at` истёк) — отправляет и помечает `reminder_sent = 1`
2. Recurring tasks — проверяет по `event_time - reminder_before_minutes`
3. Утренний план (`morning_time` совпадает, не отправляли сегодня)
4. Вечерний разбор (`evening_time` совпадает, не отправляли сегодня)

Активный пользователь = есть задача с `updated_at >= -7 days`.

**`handlers/intent.js`** — центральный роутер голоса/текста: Whisper → parser → выбирает нужный handler.

---

## База данных

SQLite, файл `data.db` (или `data_dev.db` при `DEV=true`, или `$DATA_DIR/data.db` на Railway).

### Схема

```sql
users             — id (telegram user_id), username
categories        — id, user_id, name, color
goals             — id, user_id, title, description, status (active/archived), notion_page_id
tasks             — id, user_id, title, description,
                    status (todo/waiting/maybe/done/deleted),
                    priority (high/medium/low),
                    category_id → categories,
                    goal_id → goals,
                    planned_for (DATE),
                    waiting_reason, waiting_until (DATE),
                    reminder_at (DATETIME UTC), reminder_sent (0/1),
                    notion_page_id
subtasks          — id, task_id CASCADE, title, is_done, position, notion_block_id
user_settings     — user_id PK, morning_time, evening_time, timezone,
                    morning_enabled, review_enabled, quiet_until, notion_enabled
recurrent_tasks   — id, user_id, title, event_time (HH:MM), days (JSON [0-6]),
                    day_of_month, reminder_before_minutes
notification_log  — id, user_id, type, task_id, sent_at, reacted
sync_errors       — id, user_id, message, created_at
```

### Статусы задач

| Статус | Смысл |
|--------|-------|
| `todo` | взял в работу, дефолт при создании |
| `waiting` | жду внешнего события или даты |
| `maybe` | возможно когда-нибудь |
| `done` | готово |
| `deleted` | soft delete |

### Временные зоны

Все datetime в БД хранятся в **UTC**. Конвертация происходит в `shared/helpers.js`. Дефолтная зона: `Asia/Oral` (UTC+5, Казахстан).

---

## Поток создания задачи

```
Пользователь пишет/говорит
  → [голос] whisper.js → текст
  → parser.js (Claude) → { intent: "create_task", title, status, ... }
  → handlers/intent.js → formatters.formatPreview() → показать превью
  → [confirm] application/tasks.createTask()
      → резолвинг category_id, goal_id
      → taskRepository.createTask() → INSERT
      → [если Notion] notion.js sync
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
├── planService.test.js        (тестирует application/goals)
├── subtaskService.test.js
├── categoryService.test.js
├── notionToggle.test.js       (тестирует application/settings)
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

Каждый тест создаёт свою in-memory БД через `createTestDb()`:

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
2. **Application** — добавь бизнес-логику в нужный файл `application/` (или создай новый)
3. **Handler** — добавь handler в `delivery/telegram/handlers/`
4. **Регистрация** — зарегистрируй команду в `delivery/telegram/bot.js`

### Новый intent (голосовая команда)

1. Добавь intent в промпт `infrastructure/ai/parser.js`
2. Добавь case в `delivery/telegram/handlers/intent.js`

### Новый тип уведомлений

1. Логика в `application/notifications.js` или `application/assistant.js`
2. Отправка в `delivery/telegram/scheduler.js` или отдельный notifier
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

Логи Railway показывают новые записи сверху. `Stopping Container` — старый контейнер убивается после запуска нового, это норма.
