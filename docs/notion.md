# Интеграция с Notion

Notion — опциональная интеграция. Бот полностью работает без неё.

При подключении задачи и планы синхронизируются в Notion при каждом изменении. Ошибки синхронизации не блокируют бота — они видны в `/settings`.

---

## Шаг 1 — Создай интеграцию

1. Зайди на [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. **+ New integration** → укажи название (например `Ordo`) и выбери workspace
3. Скопируй **Internal Integration Token** → это `NOTION_TOKEN`

---

## Шаг 2 — Создай базы данных

Нужны две базы: для задач и для планов.

### База задач

Создай новую базу в Notion со свойствами:

| Свойство | Тип |
|----------|-----|
| Name | Title |
| Status | Status |
| Priority | Select |
| Category | Select |
| Due Date | Date |
| Description | Text |
| Waiting Reason | Text |
| Waiting Until | Date |

Для поля **Status** добавь варианты:
- Not started → группа "Not started"
- In progress → группа "In progress"
- **Waiting** → группа "In progress"
- Done → группа "Done"

### База планов

| Свойство | Тип |
|----------|-----|
| Name | Title |
| Status | Select (`active`, `archived`) |
| Description | Text |

---

## Шаг 3 — Подключи интеграцию к базам

В каждой базе: `...` → **Connections** → найди свою интеграцию и добавь.

---

## Шаг 4 — Скопируй ID баз

Открой базу в браузере. ID — это часть URL:

```
https://notion.so/workspace/7d4939ac3f4c836ca99201ae06bafcae?v=...
                             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

---

## Шаг 5 — Добавь переменные окружения

```env
NOTION_TOKEN=ntn_xxxxxxxxxxxxxx
NOTION_DATABASE_ID=7d4939ac...
NOTION_PLANS_DATABASE_ID=324939ac...
```

После перезапуска бота в `/settings` появится статус интеграции.
