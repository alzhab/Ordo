# TaskBot

Telegram-бот для управления задачами через голос и текст. Хранит данные локально в SQLite, опционально синхронизирует с Notion.

## Возможности

- **Голосовой и текстовый ввод** — создавай задачи естественным языком
- **AI-парсинг** — Claude автоматически извлекает название, дату, категорию, приоритет, шаги
- **Планы** — группируй задачи в планы с прогрессом выполнения
- **Подзадачи** — добавляй шаги вручную или генерируй через AI
- **Голосовое управление** — "удали задачу X", "переведи Y в работу", "покажи задачи по дому"
- **Групповые операции** — "все задачи готовы", "первые 3 задачи в работу"
- **Notion sync** — опциональная двусторонняя синхронизация задач и планов

## Быстрый старт

### 1. Установка

```bash
git clone <repo>
cd ToDoParser
npm install
```

### 2. Переменные окружения

Создай файл `.env`:

```env
TELEGRAM_BOT_TOKEN=        # получить у @BotFather
GROQ_API_KEY=              # console.groq.com — для голосовых сообщений (бесплатно)
ANTHROPIC_API_KEY=         # console.anthropic.com — для парсинга задач

# Опционально — Notion интеграция
NOTION_TOKEN=
NOTION_DATABASE_ID=
NOTION_PLANS_DATABASE_ID=
```

### 3. Запуск

```bash
npm start          # продакшен
npm run dev        # с авто-перезапуском
npm test           # тесты
```

---

## Структура проекта

```
src/
├── bot.js                  — точка входа, регистрация команд и handlers
├── state.js                — общее состояние в памяти (pendingTasks, taskFilters)
├── helpers.js              — getUser(ctx)
├── formatters.js           — функции форматирования сообщений
├── keyboards.js            — построители inline-клавиатур
├── renderers.js            — renderTaskListFiltered, renderPlanTaskList
├── fuzzy.js                — fuzzy-поиск (normalize, fuzzyMatch)
│
├── parser.js               — парсинг намерений через Claude API
├── whisper.js              — транскрипция голоса через Groq
├── db.js                   — инициализация SQLite + миграции
├── config.js               — env переменные
│
├── taskService.js          — CRUD задач
├── planService.js          — CRUD планов
├── subtaskService.js       — CRUD подзадач
├── categoryService.js      — управление категориями
│
├── handlers/
│   ├── tasks.js            — handlers задач: просмотр, статус, редактирование, фильтры, bulk
│   ├── plans.js            — handlers планов: просмотр, архив, редактирование
│   ├── subtasks.js         — handlers шагов: тогл, добавить, редактировать, AI
│   └── intent.js           — обработка голоса/текста: parseIntent, handleText
│
└── integrations/
    └── notion.js           — Notion API: задачи, планы, подзадачи
```

---

## Архитектура

### Поток создания задачи

```
Пользователь → голос/текст
  → Groq Whisper (если голос) → текст
  → Claude parseIntent() → JSON намерения
  → показать превью (pendingTasks Map)
  → confirm → createTask() → SQLite
  → pushTask() → Notion (если настроен)
```

### Состояние диалога

Хранится в `pendingTasks: Map<userId, State>` (в памяти, сбрасывается при рестарте):

| Ключ | Назначение |
|------|-----------|
| `task` | задача в превью (до подтверждения) |
| `editingField` | какое поле редактируется (до сохранения) |
| `editingSavedTask` | `{id, field}` — редактирование сохранённой задачи |
| `editingPlan` | `{id, field}` — редактирование плана |
| `creatingPlan` | флаг: ждём название нового плана |
| `addingStep` | `{taskId}` — ждём название нового шага |
| `editingStep` | `{subId, taskId}` — ждём новое название шага |
| `searchingTasks` | флаг: ждём поисковый запрос |
| `voiceAction` | действие для голосовой команды (при disambig) |
| `voicePlanAction` | действие для плана (при disambig) |
| `bulkAction` | параметры групповой операции |
| `pendingSteps` | предложенные AI шаги (до подтверждения) |
| `planData` | предложенный AI план (до подтверждения) |

### Notion sync

SQLite — источник правды. Notion — опциональный зеркальный слой.

| Поле | Назначение |
|------|-----------|
| `tasks.notion_page_id` | ID страницы задачи в Notion |
| `plans.notion_page_id` | ID страницы плана в Notion |
| `subtasks.notion_block_id` | ID to_do блока подзадачи в Notion |

Sync происходит при каждом изменении. Ошибки логируются, не блокируют основной флоу.

---

## Команды бота

| Команда | Описание |
|---------|----------|
| `/start` | Приветствие |
| `/help` | Справка |
| `/add [текст]` | Создать задачу |
| `/tasks` | Список задач с фильтрами |
| `/today` | Задачи на сегодня |
| `/plans` | Список планов с прогрессом |
| `/settings` | Настройки и интеграции |

Все команды также работают через свободный текст и голос.

### Примеры голосовых команд

```
"Купить молоко, срок завтра, категория дом"
"Нужно записаться к врачу: найти номер, позвонить, записаться"
"Хочу сделать ремонт кухни" → AI создаёт план с задачами

"Удали задачу молоко"
"Переведи ремонт в работу"
"Покажи задачи по работе"
"Все задачи готовы"
"Первые 3 задачи — высокий приоритет"
```

---

## База данных

SQLite, файл `tasks.db` (создаётся автоматически при первом запуске).

### Схема

```sql
users        — telegram user id + username
categories   — id, user_id, name, color
plans        — id, user_id, title, description, status, notion_page_id
tasks        — id, user_id, title, description, status, priority,
               category_id, plan_id, due_date, notion_page_id
subtasks     — id, task_id, title, is_done, position, notion_block_id
```

### Значения полей

**tasks.status:** `not_started` | `in_progress` | `done` | `deleted`

**tasks.priority:** `high` | `medium` | `low`

**plans.status:** `active` | `archived`

Задачи не удаляются физически — `status = 'deleted'` (soft delete).

---

## Тестирование

```bash
npm test              # все тесты
npm run test:watch    # watch mode
npm run test:coverage # с покрытием
```

Тесты используют in-memory SQLite — не требуют внешних сервисов и не затрагивают реальные данные.

Покрытие: `taskService`, `planService`, `subtaskService`, `categoryService`, `parser` (мок Claude), `integrations/notion` (мок Notion client).

---

## Деплой

### Railway

```bash
# railway.json
{
  "build": { "builder": "NIXPACKS" },
  "deploy": { "startCommand": "npm start" }
}
```

⚠️ Railway имеет ephemeral filesystem — подключи Railway Volume и укажи путь к БД через env:

```env
DB_PATH=/data/tasks.db
```

### VPS

```bash
npm install --production
NODE_ENV=production npm start
# или через pm2:
pm2 start src/bot.js --name taskbot
```

---

## Принципы

- **Голос = текст = команда** — любой функционал доступен тремя способами
- **Soft delete** — задачи не удаляются физически
- **Один уровень подзадач** — без рекурсии, только чекбоксы
- **Интеграции опциональны** — бот работает без внешних сервисов
- **SQLite → PostgreSQL** — лёгкая миграция при деплое (замена драйвера)
