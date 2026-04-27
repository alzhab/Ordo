# Ordo — AI-ассистент для управления задачами

Telegram бот для голосового и текстового управления задачами. Название: **Ordo** (лат. порядок).

---

## Продуктовое видение

### Проблема которую решает Ordo

У современного человека десятки задач из разных сфер жизни — работа, семья, финансы, здоровье, бытовые дела. Стандартные таск-менеджеры хорошо **хранят** задачи, но не помогают **принимать решения**. Результат — постоянная фоновая тревога, прокрастинация, задачи делаются только когда становятся критически срочными.

**Ordo работает иначе.** Это не инструмент — это советник. Ты выгружаешь всё из головы в доверенную систему, а она сама следит за тем чтобы ничего не провисало и каждый день ты знал что делать.

### Три роли Ordo

**Секретарь** — принимает всё что ты говоришь, записывает, структурирует. Быстро, без трения.

**Планировщик** — понимает контекст задач, расставляет приоритеты, формирует план на день. Без участия пользователя.

**Диспетчер** — каждый день говорит конкретно: вот план на день, делай их, вот почему именно они.

### Ключевой принцип

Пользователь не управляет системой — он живёт, а система работает рядом. Что-то вспомнил — сказал боту. Что-то сделал — сказал боту. Получил план. Вечером очистил голову. Голова свободна.

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
├── delivery/telegram/
│   ├── bot.js                  — оркестратор: /start онбординг, команды, регистрация handlers
│   ├── scheduler.js            — cron каждую минуту: plan/review/recurring + weekly cleanup
│   ├── formatters.js           — объекты → Markdown строки
│   ├── keyboards.js            — inline-клавиатуры
│   ├── renderers.js            — рендер списка задач с фильтрами
│   └── handlers/
│       ├── tasks.js            — задачи (CRUD, фильтры, редактирование, bulk, waiting, batch)
│       ├── goals.js            — цели (CRUD, архив)
│       ├── subtasks.js         — подзадачи (toggle, add, edit, delete, AI)
│       ├── settings.js         — /settings: уведомления, категории, интеграции
│       ├── assistant.js        — /plan /review + слайдеры + календари
│       ├── seed.js             — /seed /unseed: тестовые задачи
│       └── intent.js           — голос/текст → intent → action
├── application/
│   ├── tasks.js                — createTask, saveTask, updateTask, deleteTask, cleanupDoneTasks
│   ├── goals.js                — CRUD целей, getGoalsWithProgress
│   ├── subtasks.js             — CRUD подзадач
│   ├── categories.js           — CRUD категорий
│   ├── assistant.js            — getPlanRecommendations, getReviewData
│   ├── notifications.js        — logNotification, wasNotifiedToday, syncErrors
│   └── settings.js             — getSettings, updateSettings, isQuietMode, getNotionEnabled
├── infrastructure/
│   ├── ai/claudeClient.js      — ask, askJson (Anthropic API)
│   ├── ai/whisper.js           — голос → текст (Groq Whisper)
│   ├── ai/parser.js            — текст → JSON намерения через Claude
│   ├── db/connection.js        — better-sqlite3 соединение
│   ├── db/migrations.js        — все CREATE TABLE + ALTER, запускаются при старте
│   ├── db/repositories/        — taskRepository, goalRepository, subtaskRepository, …
│   └── integrations/notion.js  — опциональный sync в Notion
└── shared/
    ├── config.js               — env переменные
    ├── helpers.js              — getUser, safeEdit, localNow, parseFlexibleDate, …
    ├── fuzzy.js                — normalize(), fuzzyMatch()
    └── state.js                — in-memory: pendingTasks, reviewData, planData, …
```

---

## Схема базы данных (SQLite)

```sql
users
- id (telegram user id), username, created_at

categories
- id, user_id, name, color

goals
- id, user_id, title, description, status (active/archived), notion_page_id, created_at

tasks
- id, user_id, title, description
- status (todo / waiting / maybe / done / deleted)
- category_id → categories
- goal_id → goals (nullable)
- planned_for DATE (nullable)
- waiting_reason TEXT, waiting_until DATE
- reminder_at DATETIME UTC, reminder_sent INTEGER
- is_recurring INTEGER DEFAULT 0
- recur_days TEXT, recur_day_of_month INT, recur_time TEXT, recur_remind_before INT
- notion_page_id TEXT
- created_at, updated_at

subtasks
- id, task_id (CASCADE), title, is_done, position, notion_block_id

user_settings
- user_id PRIMARY KEY → users
- plan_time TEXT DEFAULT '09:00'
- review_time TEXT DEFAULT '21:00'
- timezone TEXT DEFAULT 'Asia/Oral'
- plan_enabled INTEGER DEFAULT 1
- review_enabled INTEGER DEFAULT 1
- quiet_until TEXT NULL
- notion_enabled INTEGER DEFAULT 1
- created_at, updated_at

notification_log
- id, user_id, type ('plan' | 'review'), task_id, sent_at, reacted

sync_errors
- id, user_id, message, created_at
```

---

## Статусы задач

| Статус | Смысл | Когда |
|--------|-------|-------|
| `todo` | Взял обязательство, надо сделать | По умолчанию при создании |
| `waiting` | Жду чего-то внешнего | Автоопределение Claude или вручную |
| `maybe` | Отложено без конкретной даты | Кнопка [⏭ Отложить] в /review — скрывает на 7 дней |
| `done` | Готово | Вручную; очищается еженедельно |
| `deleted` | Удалено (soft delete) | Никогда не удаляется физически |

**Удалены:** `not_started`, `in_progress` — конвертированы в `todo` при миграции.
**Удалён:** `priority` — расставляет AI по контексту, не пользователь вручную.

---

## Жизненный цикл задач

**Единственный момент принятия решения — `/review`.** Задача создаётся без трения, система сама поднимает её в нужный момент.

- **todo без даты** → 0-6 дней лежит в inbox → 7+ дней попадает в /review
- **waiting с датой** → бот молчит до наступления → дата прошла → /review
- **waiting без даты** → 5+ дней → /review
- **maybe** → исчезает из /review на 7 дней → снова появляется
- **is_recurring** → после done: сбрасывается на следующий цикл, не удаляется

---

## Переменные окружения (.env)

```env
TELEGRAM_BOT_TOKEN=
GROQ_API_KEY=
ANTHROPIC_API_KEY=
NOTION_TOKEN=              # опционально
NOTION_DATABASE_ID=
NOTION_PLANS_DATABASE_ID=
NOTION_DATABASE_ID_DEV=
NOTION_PLANS_DATABASE_ID_DEV=
DEV=true                   # data_dev.db + dev Notion базы
DATA_DIR=/data             # Railway: путь к volume
```

---

## UX и функционал

### Создание задачи — без трения

1. Пользователь говорит или пишет задачу свободным текстом
2. Бот **немедленно сохраняет** и показывает подтверждение с кнопками `[✏️ Изменить]` `[🗑 Отменить]`
3. Никаких обязательных полей

**Автоопределение waiting:** фразы "записался", "заказал", "отправил", "жду", "договорился" → Claude автоматически ставит `status: waiting`.

**Инференс категории:** Claude определяет категорию из контекста. Если нет подходящей — создаёт новую.

### Голосовые/текстовые намерения

| Intent | Описание |
|---|---|
| `create_task` | Создать одну задачу |
| `create_tasks_batch` | Несколько задач одним сообщением |
| `create_recurring` | Одно повторяющееся напоминание |
| `create_recurring_batch` | Несколько повторяющихся с разными расписаниями |
| `create_goal` | Создать пустую цель |
| `suggest_goal` | AI разбивает цель на план + задачи |
| `manage_task` | Изменить/удалить задачу (fuzzy-поиск) |
| `manage_goal` | Управление целью |
| `query_tasks` | Показать задачи по фильтру |
| `manage_tasks_bulk` | Групповые операции |
| `manage_category` | Управление категориями |
| `manage_settings` | Настройки ассистента голосом |

### Команды

| Команда | Описание |
|---|---|
| `/start` | Онбординг (новый) или приветствие (возвращающийся) |
| `/help` | Справка |
| `/add` | Добавить задачу |
| `/tasks` | Список задач с фильтрами (включая 🔄 Повторяющиеся) |
| `/goals` | Цели |
| `/plan` | План на день + AI-рекомендации |
| `/review` | Разбор зависших задач |
| `/settings` | Настройки и интеграции |
| `/seed` | Создать тестовые задачи (🧪 Тест) |
| `/unseed` | Удалить тестовые задачи |

---

## Проактивный ассистент

```
📋 plan_time (09:00)   — /plan на сегодня (автоматически)
🔍 review_time (21:00) — /review зависших задач (автоматически)
```

### /plan — AI-приоритизация

Динамический вид над задачами. `getPlanRecommendations`:
- Задачи с `planned_for` на выбранную дату — первый слайдер
- AI выбирает до 3 задач из оставшихся: просроченные, waiting с истёкшей датой, давно не трогавшиеся, из активных целей — второй слайдер
- `maybe`-задачи и `is_recurring` **не попадают** в рекомендации

### /review — разбор зависшего

`getReviewData` собирает по 3 категориям:
1. Waiting с истёкшей датой
2. Waiting без даты 5+ дней
3. Todo без даты 7+ дней

Кнопки: `[Сегодня]` `[Завтра]` `[На этой неделе]` `[📅 Выбрать дату]` `[⏭ Отложить]` `[🗑 Удалить]`

Не отправляется автоматически если нечего разбирать.

---

## Монетизация (freemium)

> ⚠️ Граница требует проверки на реальных пользователях — см. раздел Риски

| Функция | Бесплатно | Платно (~$4-5/мес) |
|---------|-----------|-------------------|
| Создание задач (AI парсинг) | ✅ | ✅ |
| `/tasks`, `/review`, базовый `/plan` | ✅ | ✅ |
| До 3 целей | ✅ | ✅ |
| **Голосовой ввод (Whisper)** | ✅ **бесплатно** | ✅ |
| AI рекомендации в `/plan` | ❌ | ✅ |
| AI шаги (`suggestSubtasks`) | ❌ | ✅ |
| Безлимит целей | ❌ | ✅ |
| Интеграции (Google Calendar и др.) | ❌ | ✅ |

**Платежи:** Telegram Stars + Boosty + прямая оплата картой (Stars — как опция, не единственный способ)

**Обоснование:** голос — это то что отличает Ordo от любого другого таск-менеджера и даёт главное ощущение продукта. Голос — крючок, AI-рекомендации — апселл.

---

## Риски и что делать

### 🔴 Аналитика отсутствует

Неизвестно как люди используют бота. **Добавить до открытия доступа:** минимальный лог ключевых событий (создание задачи, открытие /plan, завершение /review, голос vs текст, время до первой задачи).

### 🔴 Онбординг недоработан

Новый пользователь с пустой базой не знает с чего начать. **Добавить:** один конкретный первый шаг в `/start` — "Напиши свою первую задачу прямо сейчас" с живым примером.

### 🟡 Freemium граница — гипотеза, не факт

Текущая граница не проверена. Голос должен быть бесплатным (core value), AI-рекомендации — платными. Проверять на первых пользователях.

### 🟡 Telegram Stars — не единственный способ оплаты

Stars незнакомы аудитории. Добавить Boosty или прямую оплату картой как альтернативу до запуска монетизации.

### 🟢 Изоляция данных (низкий риск сейчас)

При 2-3 пользователях всё в одной SQLite — нормально. При росте потребует PostgreSQL и изоляции per-user. Claude API cost: при 100 пользователях ~100 /plan вызовов/день — посчитать ceiling заранее.

---

## Тестирование

```
tests/
├── helpers/
│   ├── db.js, ctx.js, bot.js
├── taskService.test.js
├── planService.test.js
├── subtaskService.test.js
├── categoryService.test.js
├── parser.test.js
├── notion.test.js
└── handlers/
    ├── confirm.test.js
    ├── filters.test.js
    ├── plans.test.js
    ├── subtasks.test.js
    ├── waiting.test.js
    └── edit_saved.test.js
```

**Запуск:** `npm test` — все тесты зелёные перед деплоем.

---

## Roadmap

### ✅ Сделано

- Статусы: `not_started`/`in_progress` → `todo`; добавлен `maybe`
- Документационный сайт на GitHub Pages (VitePress, landing по PAS, тестовый режим)
- **Фаза 7 — Проактивный ассистент:**
    - `user_settings` + `notification_log` в БД
    - `/plan` — сегодня + календарь + AI-рекомендации (до 3) + слайдер; timezone-aware
    - `/review` — плоский слайдер, кнопки выбора даты/откладывания, итоговый экран
    - `scheduler.js` — автоотправка по расписанию, graceful shutdown
    - `manage_settings` intent — голосовое управление уведомлениями
    - Повторяющиеся задачи (`is_recurring`) — batch, 🔄 в списках, weekly cleanup
    - `/seed` / `/unseed` — тестовые данные
    - `/start` онбординг — новый vs возвращающийся пользователь
    - Notion UI скрыт (код сохранён)

### 🚀 Сейчас — Первые пользователи

- [ ] Улучшить онбординг: конкретный первый шаг для нового пользователя с примером
- [ ] Добавить минимальную аналитику (лог событий: /plan, /review, голос/текст)
- [ ] Открыть доступ 2-3 пользователям (брат, жена)
- [ ] Собрать фидбек, стабилизировать

### 💳 Монетизация (после фидбека)

- Пересмотреть freemium границу: голос → бесплатно
- Добавить Boosty / прямую оплату картой рядом с Stars
- Запустить платный план

### Фаза 8 — Интеграции

- **Google Calendar / Apple Calendar** — высокий приоритет, снижает барьер входа для широкой аудитории
- **Notion** — backend готов, включить через `/settings`
- **Obsidian** — отдельный плагин (TypeScript)

### Фаза 9 — API слой

- `delivery/api/` (Express/Fastify) рядом с `delivery/telegram/`
- `application/` уже транспорт-агностик — просто обернуть в REST endpoints
- JWT auth через Telegram user_id

### Фаза 10 — React Native

- Геолокационные напоминания, rich notifications, виджет на экран
- Siri / Google Assistant, камера → фото в задачу
- Оффлайн-режим (local-first SQLite, sync при появлении сети)

### Фаза 11 — TypeScript миграция

---

## Принципы разработки

- **Голос = текст = команда**: любой функционал доступен тремя способами
- **Захват без трения**: никаких обязательных полей при создании задачи
- **AI расставляет приоритеты**: пользователь не думает о приоритетах вручную
- **Бот — советник, не диктатор**: предлагает, объясняет, пользователь решает
- **Soft delete**: задачи не удаляются физически
- **Один уровень подзадач**: без рекурсии
- **Интеграции опциональны**: бот работает полностью без Notion
- **Ошибки интеграций не блокируют основной флоу**
- **SQLite → PostgreSQL**: лёгкая миграция при масштабировании
