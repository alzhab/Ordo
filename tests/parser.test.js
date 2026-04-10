// Мокаем Anthropic SDK до импорта parser
const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }));
});
jest.mock('../src/shared/config', () => ({
  ANTHROPIC_API_KEY: 'test-key',
}));

const { parseIntent, suggestSubtasks } = require('../src/infrastructure/ai/parser');

function mockResponse(text) {
  mockCreate.mockResolvedValueOnce({
    content: [{ text }],
  });
}

describe('parseIntent — create_task', () => {
  test('парсит простую задачу', async () => {
    mockResponse(JSON.stringify({
      intent: 'create_task',
      title: 'Купить молоко',
      description: null,
      plannedFor: null,
      category: null,
      priority: null,
      plan: null,
      subtasks: null,
    }));

    const result = await parseIntent('Купить молоко');
    expect(result.intent).toBe('create_task');
    expect(result.title).toBe('Купить молоко');
  });

  test('парсит задачу с подзадачами', async () => {
    mockResponse(JSON.stringify({
      intent: 'create_task',
      title: 'Записаться к врачу',
      description: null,
      plannedFor: null,
      category: 'Здоровье',
      priority: null,
      plan: null,
      subtasks: ['Найти номер клиники', 'Позвонить', 'Записаться'],
    }));

    const result = await parseIntent('Записаться к врачу: найти номер, позвонить, записаться');
    expect(result.intent).toBe('create_task');
    expect(result.subtasks).toHaveLength(3);
    expect(result.subtasks[0]).toBe('Найти номер клиники');
  });

  test('передаёт категории и планы в промпт', async () => {
    mockResponse(JSON.stringify({ intent: 'create_task', title: 'Тест', description: null, plannedFor: null, category: 'Работа', priority: null, plan: null, subtasks: null }));

    await parseIntent('текст', ['Работа', 'Дом'], ['План 1']);
    const callArgs = mockCreate.mock.calls.at(-1)[0];
    expect(callArgs.system).toContain('"Работа"');
    expect(callArgs.system).toContain('"План 1"');
  });
});

describe('parseIntent — manage_task', () => {
  test('парсит удаление задачи', async () => {
    mockResponse(JSON.stringify({
      intent: 'manage_task',
      search: 'молоко',
      action: 'delete',
      status: null,
      plan: null,
      category: null,
      date: null,
      priority: null,
    }));

    const result = await parseIntent('удали задачу молоко');
    expect(result.intent).toBe('manage_task');
    expect(result.action).toBe('delete');
  });

  test('парсит смену статуса', async () => {
    mockResponse(JSON.stringify({
      intent: 'manage_task',
      search: 'задача',
      action: 'update_status',
      status: 'done',
      plan: null,
      category: null,
      date: null,
      priority: null,
    }));

    const result = await parseIntent('отметь задачу выполненной');
    expect(result.intent).toBe('manage_task');
    expect(result.status).toBe('done');
  });
});

describe('parseIntent — query_tasks', () => {
  test('парсит запрос задач по категории', async () => {
    mockResponse(JSON.stringify({
      intent: 'query_tasks',
      category: 'Дом',
      plan: null,
      status: null,
      date: null,
    }));

    const result = await parseIntent('покажи задачи по дому');
    expect(result.intent).toBe('query_tasks');
    expect(result.category).toBe('Дом');
  });
});

describe('parseIntent — suggest_plan', () => {
  test('парсит suggest_plan', async () => {
    mockResponse(JSON.stringify({
      intent: 'suggest_plan',
      title: 'Подготовка к свадьбе',
      description: null,
      tasks: [
        { title: 'Выбрать место', category: null, priority: null, dueDate: null, subtasks: ['Исследовать варианты', 'Посетить площадки'] },
        { title: 'Пригласить гостей', category: null, priority: null, dueDate: null, subtasks: ['Составить список', 'Разослать приглашения'] },
      ],
    }));

    const result = await parseIntent('помоги спланировать свадьбу');
    expect(result.intent).toBe('suggest_plan');
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].subtasks).toHaveLength(2);
  });
});

describe('suggestSubtasks', () => {
  test('возвращает массив шагов', async () => {
    mockResponse(JSON.stringify(['Шаг 1', 'Шаг 2', 'Шаг 3']));

    const steps = await suggestSubtasks('Купить машину');
    expect(Array.isArray(steps)).toBe(true);
    expect(steps).toHaveLength(3);
  });

  test('передаёт существующие шаги в контекст', async () => {
    mockResponse(JSON.stringify(['Шаг 1', 'Шаг 2', 'Шаг 3', 'Шаг 4']));

    const existing = [{ title: 'Шаг 1' }, { title: 'Шаг 2' }];
    const steps = await suggestSubtasks('Купить машину', 'описание', existing);
    expect(steps).toHaveLength(4);

    const callArgs = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0];
    expect(callArgs.messages[0].content).toContain('Уже есть шаги');
    expect(callArgs.system).toContain('не дублируй');
  });
});
