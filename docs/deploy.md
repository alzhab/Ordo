---
title: Деплой своего бота
nav_order: 4
---

# Деплой своего бота

Если хочешь поднять собственный экземпляр Ordo.

---

## Что потребуется

| Сервис | Назначение | Цена |
|--------|-----------|------|
| [BotFather](https://t.me/BotFather) | Создать Telegram-бота | Бесплатно |
| [Groq](https://console.groq.com) | Speech-to-text (Whisper) | Бесплатно |
| [Anthropic](https://console.anthropic.com) | AI-парсинг задач | ~$1–5/мес |
| [Railway](https://railway.app) | Хостинг бота | ~$5/мес |

Notion — опционально.

---

## Шаг 1 — Создай бота в Telegram

1. Напиши [@BotFather](https://t.me/BotFather)
2. `/newbot` → укажи имя и username
3. Скопируй токен — это `TELEGRAM_BOT_TOKEN`

---

## Шаг 2 — Получи API ключи

**Groq (бесплатно):**
1. Зарегистрируйся на [console.groq.com](https://console.groq.com)
2. API Keys → Create API Key
3. Скопируй — это `GROQ_API_KEY`

**Anthropic:**
1. Зарегистрируйся на [console.anthropic.com](https://console.anthropic.com)
2. API Keys → Create Key
3. Скопируй — это `ANTHROPIC_API_KEY`

---

## Шаг 3 — Деплой на Railway

### Клонируй репозиторий

```bash
git clone https://github.com/your-username/ordo.git
cd ordo
```

### Создай проект на Railway

1. Зайди на [railway.app](https://railway.app) → New Project
2. **Deploy from GitHub repo** → выбери репо
3. Дождись первого деплоя (он упадёт — переменные ещё не заданы)

### Добавь переменные окружения

В Railway → твой сервис → **Variables → Raw Editor**, вставь:

```env
TELEGRAM_BOT_TOKEN=your_token
GROQ_API_KEY=your_key
ANTHROPIC_API_KEY=your_key
DEV=false
```

### Подключи Volume для базы данных

Railway использует ephemeral filesystem — без Volume данные сбросятся при рестарте.

1. Railway → New → Volume
2. Примонтируй к сервису, путь: `/data`
3. Добавь переменную:
   ```env
   DB_PATH=/data/data.db
   ```

### Передеплой

После добавления переменных нажми **Redeploy** — бот запустится.

---

## Деплой на VPS

```bash
# Клонируй репо
git clone https://github.com/your-username/ordo.git
cd ordo

# Установи зависимости
npm install --production

# Создай .env файл
cp .env.example .env
nano .env  # заполни значения

# Запусти через pm2
npm install -g pm2
pm2 start src/bot.js --name ordo
pm2 save
pm2 startup
```

---

## Локальный запуск (для разработки)

```bash
git clone https://github.com/your-username/ordo.git
cd ordo
npm install
cp .env.example .env
# Заполни .env
npm run dev   # с авто-перезапуском
npm test      # запустить тесты
```

---

## Переменные окружения

| Переменная | Обязательная | Описание |
|------------|:---:|---------|
| `TELEGRAM_BOT_TOKEN` | ✅ | Токен от @BotFather |
| `GROQ_API_KEY` | ✅ | Ключ Groq для голоса |
| `ANTHROPIC_API_KEY` | ✅ | Ключ Anthropic для парсинга |
| `NOTION_TOKEN` | — | Токен Notion интеграции |
| `NOTION_DATABASE_ID` | — | ID базы задач |
| `NOTION_PLANS_DATABASE_ID` | — | ID базы планов |
| `DB_PATH` | — | Путь к SQLite файлу (по умолчанию `./data.db`) |
| `DEV` | — | `true` — dev режим с отдельной БД |
