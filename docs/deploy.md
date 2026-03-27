# Деплой своего бота

## Что потребуется

| Сервис | Назначение | Цена |
|--------|-----------|------|
| [BotFather](https://t.me/BotFather) | Создать Telegram-бота | Бесплатно |
| [Groq](https://console.groq.com) | Speech-to-text (Whisper) | Бесплатно |
| [Anthropic](https://console.anthropic.com) | AI-парсинг задач | ~$1–5/мес |
| [Railway](https://railway.app) | Хостинг | ~$5/мес |

Notion — опционально.

---

## Шаг 1 — Создай бота в Telegram

1. Напиши [@BotFather](https://t.me/BotFather)
2. `/newbot` → укажи имя и username
3. Скопируй токен — это `TELEGRAM_BOT_TOKEN`

---

## Шаг 2 — Получи API ключи

**Groq (бесплатно):**
1. [console.groq.com](https://console.groq.com) → API Keys → Create
2. Скопируй — это `GROQ_API_KEY`

**Anthropic:**
1. [console.anthropic.com](https://console.anthropic.com) → API Keys → Create
2. Скопируй — это `ANTHROPIC_API_KEY`

---

## Шаг 3 — Деплой на Railway

**Форкни репозиторий** на GitHub, затем:

1. [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**
2. Выбери форкнутый репо
3. Подожди первый деплой (упадёт — переменные ещё не заданы)

### Переменные окружения

Railway → сервис → **Variables → Raw Editor**:

```env
TELEGRAM_BOT_TOKEN=your_token
GROQ_API_KEY=your_key
ANTHROPIC_API_KEY=your_key
DEV=false
```

### Volume для базы данных

⚠️ Railway сбрасывает файлы при рестарте — нужен Volume:

1. Railway → **New → Volume** → примонтируй к сервису, путь `/data`
2. Добавь переменную: `DB_PATH=/data/data.db`

### Передеплой

После добавления переменных → **Redeploy**. Бот запустится.

---

## Деплой на VPS

```bash
git clone https://github.com/your-username/ordo.git
cd ordo
npm install --production
cp .env.example .env
nano .env  # заполни значения

# Запуск через pm2
npm install -g pm2
pm2 start src/bot.js --name ordo
pm2 save && pm2 startup
```

---

## Локальный запуск

```bash
git clone https://github.com/your-username/ordo.git
cd ordo
npm install
cp .env.example .env
# Заполни .env
npm run dev   # с авто-перезапуском
npm test      # тесты
```

---

## Все переменные окружения

| Переменная | Обяз. | Описание |
|------------|:-----:|---------|
| `TELEGRAM_BOT_TOKEN` | ✅ | Токен от @BotFather |
| `GROQ_API_KEY` | ✅ | Ключ Groq для голоса |
| `ANTHROPIC_API_KEY` | ✅ | Ключ Anthropic для парсинга |
| `NOTION_TOKEN` | — | Токен Notion интеграции |
| `NOTION_DATABASE_ID` | — | ID базы задач |
| `NOTION_PLANS_DATABASE_ID` | — | ID базы планов |
| `DB_PATH` | — | Путь к SQLite (по умолчанию `./data.db`) |
| `DEV` | — | `true` — dev режим с отдельной БД |
