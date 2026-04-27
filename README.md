# Ordo — AI-ассистент для управления задачами

> Не просто таск-менеджер — советник. Ты выгружаешь всё из головы, а система сама следит чтобы ничего не провисало и каждый день ты знал что делать.

Telegram бот на Node.js. SQLite локально, опциональная синхронизация с Notion.

---

## Roadmap

### ✅ Готово

- Создание задач голосом и текстом с AI-парсингом (захват без трения)
- Статусы: `todo`, `waiting`, `maybe`, `done`
- Повторяющиеся задачи с расписанием
- Проактивный `/plan` с AI-рекомендациями
- `/review` — ежевечерний разбор зависших задач
- Цели, категории (автоопределение), напоминания
- Планировщик уведомлений (timezone-aware)
- AI шаги с редактором (список + слайдер)

### 🚀 Сейчас — Первые пользователи

- Улучшить онбординг (конкретный первый шаг для нового пользователя)
- Добавить минимальную аналитику (лог событий)
- Открыть доступ 2-3 пользователям, собрать фидбек, стабилизировать

### 💳 Монетизация (freemium)

| Функция | Бесплатно | Платно (~$4-5/мес) |
|---------|-----------|-------------------|
| Создание задач (AI парсинг) | ✅ | ✅ |
| `/tasks`, `/review`, базовый `/plan` | ✅ | ✅ |
| До 3 целей | ✅ | ✅ |
| **Голосовой ввод** | ✅ | ✅ |
| AI рекомендации в `/plan` | ❌ | ✅ |
| AI шаги (`suggestSubtasks`) | ❌ | ✅ |
| Безлимит целей | ❌ | ✅ |
| Интеграции | ❌ | ✅ |

Платежи: Telegram Stars + Boosty + прямая оплата картой.

### 📅 Фаза 8 — Интеграции

- **Google Calendar / Apple Calendar** — высокий приоритет, снижает барьер входа
- **Notion** — backend готов, включить через настройки
- **Obsidian** — через отдельный плагин (TypeScript)

### ⚙️ Фаза 9 — API слой

REST API (`delivery/api/`) рядом с Telegram-ботом. `application/` уже транспорт-агностик — просто обернуть в endpoints. Подготовка к мобильному приложению.

### 📱 Фаза 10 — React Native

- Геолокационные напоминания, rich notifications, виджет с планом на день
- Siri / Google Assistant интеграция
- Оффлайн-режим (local-first SQLite, sync при появлении сети)

### 🔷 Фаза 11 — TypeScript миграция

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

4 слоя, зависимости строго сверху вниз:

```
delivery  →  application  →  infrastructure
                ↘                  ↘
                         shared ←←←←←←
```

**Правило:** `application/` не знает про Telegram. REST API и мобильное приложение (Фазы 9-10) переиспользуют `application/` без изменений.

```
src/
├── shared/          — утилиты без зависимостей (helpers, fuzzy, state, config)
├── application/     — бизнес-логика: tasks, goals, assistant, settings, notifications
├── infrastructure/  — внешние сервисы: AI (Claude, Whisper), DB (SQLite), Notion
└── delivery/
    └── telegram/    — всё специфичное для Telegram: bot, scheduler, handlers
```

---

## Деплой (Railway)

Тип сервиса: **Worker** (не Web — нет HTTP).

```env
DATA_DIR=/data    # Railway Volume — там живёт data.db
```

БД монтируется как volume. Миграции запускаются автоматически при старте.

---

## Тестирование

```bash
npm test
```

In-memory SQLite, Claude и Notion мокаются. Паттерн изоляции:

```js
beforeEach(() => {
  mockTestDb = createTestDb();
  jest.resetModules();
  jest.mock('../src/infrastructure/db/connection', () => mockTestDb);
  service = require('../src/application/tasks');
});
```
