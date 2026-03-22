---
title: Интеграция с Notion
nav_order: 3
---

# Интеграция с Notion

Notion — опциональная интеграция. Бот полностью работает без неё.

При подключении задачи и планы автоматически синхронизируются в Notion при каждом изменении. Ошибки синхронизации не блокируют работу бота — они тихо логируются и видны в `/settings`.

---

## Что синхронизируется

- Задачи (название, описание, статус, приоритет, дата, категория, ожидание)
- Подзадачи (как чекбоксы внутри страницы задачи)
- Планы

---

## Шаг 1 — Создай интеграцию Notion

1. Зайди на [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Нажми **+ New integration**
3. Укажи название (например, `Ordo Bot`) и выбери workspace
4. Скопируй **Internal Integration Token** — это твой `NOTION_TOKEN`

---

## Шаг 2 — Создай базы данных

Нужны две базы: для **задач** и для **планов**.

### База задач (ToDos)

Создай новую базу в Notion со следующими свойствами:

| Свойство | Тип |
|----------|-----|
| Name | Title (по умолчанию) |
| Status | Status |
| Priority | Select |
| Category | Select |
| Due Date | Date |
| Description | Text |
| Waiting Reason | Text |
| Waiting Until | Date |

Для поля **Status** добавь следующие варианты:
- Группа "Not started": `Not started`
- Группа "In progress": `In progress`, `Waiting`
- Группа "Done": `Done`

### База планов

Создай вторую базу со свойствами:

| Свойство | Тип |
|----------|-----|
| Name | Title (по умолчанию) |
| Status | Select (`active`, `archived`) |
| Description | Text |

---

## Шаг 3 — Подключи интеграцию к базам

В каждой базе:
1. Нажми `...` → **Connections**
2. Найди свою интеграцию (`Ordo Bot`) и добавь

---

## Шаг 4 — Скопируй ID баз

ID базы — это часть URL. Открой базу в браузере:

```
https://notion.so/yourworkspace/7d4939ac3f4c836ca99201ae06bafcae?v=...
                                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                                        это и есть ID
```

---

## Шаг 5 — Добавь переменные окружения

```env
NOTION_TOKEN=ntn_xxxxxxxxxxxxxx
NOTION_DATABASE_ID=7d4939ac...      # ID базы задач
NOTION_PLANS_DATABASE_ID=324939ac... # ID базы планов
```

После перезапуска бота в `/settings` появится статус интеграции.

---

## Проверка статуса

Отправь `/settings` — там видно:
- Подключён ли Notion
- Последние ошибки синхронизации (если есть)
