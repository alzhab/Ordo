# Ordo — Telegram Task Manager

Telegram бот для голосового и текстового управления задачами. Название: **Ordo** (лат. порядок). Работает независимо от внешних сервисов, с опциональными интеграциями.

---

## Стек

- **Runtime**: Node.js
- **Telegram**: Telegraf
- **База данных**: SQLite (`better-sqlite3`)
- **Speech-to-text**: Groq Whisper API
- **Парсинг задач**: Anthropic Claude API (`claude-sonnet-4-6`)
- **Интеграция**: Notion API (`@notionhq/client` v5, опционально)
- **Тесты**: Jest + in-memory SQLite

---

## Структура проекта

```
src/
├── bot.js                  — оркестратор: команды /start /help /settings /add + регистрация handlers
├── state.js                — общее in-memory состояние (pendingTasks, taskFilters, taskPlanContext, processingUsers)
├── helpers.js              — getUser, parseFlexibleDate, extractDateFromText, normalizeWaiting, extractNotionPageId
├── formatters.js           — все функции форматирования текста (formatTaskDetail, formatPreview, formatBatchTaskPreview и др.)
├── keyboards.js            — построители inline-клавиатур (taskDetailButtons, stepsButtons и др.)
├── renderers.js            — renderTaskListFiltered, renderPlanTaskList
├── fuzzy.js                — normalize(), fuzzyMatch()
├── parser.js               — текст/голос → JSON намерения через Claude
├── whisper.js              — голос → текст через Groq
├── db.js                   — инициализация SQLite, создание таблиц, миграции
├── taskService.js          — CRUD задач
├── planService.js          — CRUD планов
├── subtaskService.js       — CRUD подзадач
├── categoryService.js      — управление категориями
├── syncErrorService.js     — логирование ошибок Notion sync
├── config.js               — env переменные (DEV режим)
├── handlers/
│   ├── tasks.js            — обработчики задач (CRUD, фильтры, редактирование, bulk, waiting, batch)
│   ├── plans.js            — обработчики планов (CRUD, архив)
│   ├── subtasks.js         — обработчики шагов (toggle, add, edit, delete, AI)
│   ├── settings.js         — /settings: Notion статус, категории, ошибки sync
│   └── intent.js           — голос/текст → intent + handleText + executeTaskAction
└── integrations/
    └── notion.js           — опциональный sync в Notion
```

---

## Схема базы данных (SQLite)

```sql
users
- id (telegram user id)
- username
- created_at

categories
- id
- user_id
- name
- color

plans
- id
- user_id
- title
- description
- status (active / archived)
- notion_page_id
- created_at

tasks
- id
- user_id
- title
- description
- status (not_started / in_progress / waiting / done / deleted)
- priority (high / medium / low)
- category_id → categories
- plan_id → plans (nullable)
- due_date (nullable)
- notion_page_id
- waiting_reason TEXT (nullable)
- waiting_until DATE (nullable)
- created_at
- updated_at

subtasks
- id
- task_id → tasks (ON DELETE CASCADE)
- title
- is_done
- position
- notion_block_id

sync_errors
- id
- user_id
- message
- created_at
```

---

## Переменные окружения (.env)

```env
TELEGRAM_BOT_TOKEN=        # @BotFather
GROQ_API_KEY=              # console.groq.com (Whisper, бесплатно)
ANTHROPIC_API_KEY=         # console.anthropic.com (парсинг)
NOTION_TOKEN=              # опционально
NOTION_DATABASE_ID=        # прод база задач
NOTION_PLANS_DATABASE_ID=  # прод база планов
NOTION_DATABASE_ID_DEV=    # dev база задач
NOTION_PLANS_DATABASE_ID_DEV= # dev база планов
DEV=true                   # если true — использует data_dev.db + dev Notion базы
```

`DEV=true` → SQLite файл `data_dev.db`, Notion базы `*_DEV`.
`DEV=false` (или не задано) → `data.db`, прод Notion базы.

---

## UX и функционал

### Создание задачи
1. Пользователь пишет или говорит задачу свободным текстом
2. Для голоса — показывается транскрипция
3. Claude парсит поля: название, описание, дата, категория, приоритет, план, подзадачи, статус waiting
4. Превью с кнопками `[✅ Создать]` `[✏️ Изменить]` `[❌ Отмена]`
5. После создания — задача сохраняется в SQLite, опционально синхронизируется в Notion

Если фраза подразумевает уже совершённое действие + ожидание результата ("записался", "заказал", "отправил"), Claude автоматически ставит `status: "waiting"` с `waiting_reason` и `waiting_until`.

### Голосовые/текстовые намерения
| Intent | Описание |
|---|---|
| `create_task` | Создать одну задачу (с автоопределением waiting) |
| `create_tasks_batch` | Несколько независимых задач — слайдер по одной `[✅ Создать]` `[⏭ Пропустить]` |
| `create_plan` | Создать пустой план |
| `suggest_plan` | AI разбивает цель на план + 3–5 задач с подзадачами |
| `manage_task` | Изменить/удалить конкретную задачу (fuzzy-поиск) |
| `query_tasks` | Показать задачи по фильтру |
| `manage_plan` | Архивировать/удалить/показать задачи плана |
| `manage_tasks_bulk` | Групповое действие (все/первые N/последние N/половина) |
| `manage_category` | Создать/удалить/показать категории |

### Статус "В ожидании" (waiting)
- Поля `waiting_reason` и `waiting_until` хранятся в SQLite и синхронизируются в Notion
- Двухшаговый диалог при переводе задачи в waiting: причина → дата (оба шага можно пропустить)
- Автоизвлечение даты из текста причины (`extractDateFromText`, `normalizeWaiting`)
- Фильтр ⏸ в `/tasks`, сортировка по `waiting_until`, ⚠️ для просроченных
- Редактирование `waiting_reason` и `waiting_until` через ✏️ в карточке задачи

### Команды
| Команда | Описание |
|---|---|
| `/start` | Приветствие |
| `/help` | Справка |
| `/add` | Добавить задачу (альтернатива тексту) |
| `/tasks` | Список задач с фильтрами |
| `/today` | Задачи на сегодня |
| `/plans` | Список планов |
| `/settings` | Настройки: Notion, категории, ошибки sync |

### Фильтры `/tasks`
- По статусу: В работе / Не начато / В ожидании / Выполненные / Все активные (дефолт: `in_progress`)
- По категории, по плану, архив
- Фильтры сохраняются per-user в памяти между вызовами

---

## Тестирование

```
tests/
├── helpers/
│   ├── db.js               — createTestDb(): in-memory SQLite с полной схемой
│   ├── ctx.js              — mockCtx(): мок Telegraf-контекста
│   └── bot.js              — createMockBot(): захват handlers через register(bot), вызов через .trigger()
├── taskService.test.js
├── planService.test.js
├── subtaskService.test.js
├── categoryService.test.js
├── parser.test.js          — мок @anthropic-ai/sdk
├── notion.test.js          — мок @notionhq/client
└── handlers/
    ├── confirm.test.js
    ├── filters.test.js
    ├── plans.test.js
    ├── subtasks.test.js
    ├── waiting.test.js
    └── edit_saved.test.js
```

**Запуск:** `npm test` — 203 теста, все должны быть зелёными перед деплоем.

Паттерн изоляции: `jest.resetModules()` + re-require в `beforeEach`, каждый тест получает чистую in-memory БД.

---

## План деплоя и развития

### Шаг 1 — Деплой ← *сейчас*

**Чеклист перед деплоем:**
1. В продовой Notion базе `ToDos` добавить:
    - Статус `Waiting` в поле Status (группа "In progress")
    - Свойство `Waiting Reason` (тип Text)
    - Свойство `Waiting Until` (тип Date)
2. `npm test` → все 203 теста зелёные
3. Деплой на Railway + Volume для SQLite

**Railway:**
- ⚠️ Ephemeral filesystem → обязательно Railway Volume для `data.db`
- Альтернатива: PostgreSQL (схема совместима, замена драйвера)
- Нужны: `railway.json` + `Procfile`

---

### Шаг 2 — Личное тестирование (3-4 дня после деплоя)

Цель: убедиться что всё работает в продакшне на реальном использовании.

- Использовать бота ежедневно для реальных задач
- Фиксировать баги в Regression Log в Notion
- Критичные баги — фиксить сразу, некритичные — накапливать

---

### Шаг 3 — Подготовка к первым пользователям

После успешного личного тестирования:

1. **ONBOARDING.md** — инструкция для нового пользователя: как подключить бота, настроить Notion, какие команды есть
2. **Настройка Notion для пользователей** — каждый пользователь подключает свои базы через `/settings` (добавить UI для ввода Notion credentials)
3. **PRIVACY.md** — что хранится, где, как удалить
4. Дать доступ 2-3 людям и собрать обратную связь

---

### Шаг 4 — Фаза 7: Напоминания (после деплоя и первых пользователей)

Полная спецификация: **Notion → TaskBot QA → Фаза 7 — Напоминания: Спецификация**

**Три типа уведомлений:**

**7.1 — Триггерные (по событию):**
- `waiting_until` истёк → "⏸ Срок ожидания вышел: [задача]. Что делаем?" + кнопки `[✅ Готово]` `[▶️ В работу]` `[📅 Перенести]`
- `due_date` = сегодня → утром в 9:00 вместе с дайджестом
- `due_date` = завтра → вечером в 21:00 тихое напоминание

**7.2 — Утренний дайджест (9:00):**
- Истёкшие waiting → дедлайны сегодня → top-3 в работе
- Максимум 7 задач, иначе это уже список
- Не отправлять если пользователь неактивен 7+ дней

**7.3 — Умные подсказки (Фаза 7.2, опционально):**
- Задача без изменений 7+ дней → "Может, пора взяться?"
- Много задач в `in_progress` → "Может, стоит что-то закрыть?"

**Новые таблицы БД:**
```sql
user_settings
- user_id, digest_time ('09:00'), evening_time ('21:00')
- timezone ('Asia/Almaty'), digest_enabled, reminders_enabled
- quiet_until (ISO datetime, тихий режим до)

notification_log
- id, user_id, type, task_id, sent_at, reacted
```

**Новые файлы:**
```
src/
├── scheduler.js            — регистрация cron jobs, graceful shutdown
├── notificationService.js  — canNotify, markSent, markReacted
├── notifiers/
│   ├── digest.js
│   ├── waitingExpired.js
│   └── dueTomorrow.js
└── handlers/notifications.js
```

**Правила антиспама:**
- Одно уведомление = один раз в 24ч (проверка через `notification_log`)
- Тихий режим: ничего не отправляется
- Не более 3 уведомлений в день суммарно
- Если пользователь отреагировал — повтор не нужен

**Голосовые команды (новый intent `manage_settings`):**
- "не беспокой до завтра" → `set_quiet_mode`
- "поставь дайджест на 8 утра" → `set_digest_time`
- "выключи напоминания" → `disable_reminders`

---

### Шаг 5 — Фаза 8 и далее (после стабильной работы с пользователями)

**Фаза 8 — Дополнительные интеграции:**
- Google Tasks (OAuth, sync)
- Obsidian (Local REST API, экспорт `.md`)
- Apple Reminders (AppleScript, macOS)

**Фаза 9 — Расширенный функционал:**
- Кастомные поля задачи
- Импорт из Notion → Telegram
- TypeScript (постепенная миграция по файлу)

---

## Принципы разработки

- **Голос = текст = команда**: любой функционал доступен тремя способами
- **Soft delete**: задачи не удаляются физически, меняется статус на `deleted`
- **Один уровень подзадач**: без рекурсии, только чекбоксы внутри задачи
- **Интеграции опциональны**: бот полностью работает без внешних сервисов
- **Ошибки интеграций не блокируют основной флоу**: логируются тихо
- **SQLite → PostgreSQL**: лёгкая миграция при деплое
- **Тесты**: Jest + in-memory SQLite, 203 теста, паттерн createMockBot для handler-уровня
