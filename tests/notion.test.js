// Мокаем Notion client и config до импорта модуля
const mockPagesCreate = jest.fn();
const mockPagesUpdate = jest.fn();
const mockPagesRetrieve = jest.fn();
const mockBlocksChildrenList = jest.fn();
const mockBlocksChildrenAppend = jest.fn();
const mockBlocksDelete = jest.fn();
const mockBlocksUpdate = jest.fn();

jest.mock('@notionhq/client', () => ({
  Client: jest.fn().mockImplementation(() => ({
    pages: {
      create: mockPagesCreate,
      update: mockPagesUpdate,
      retrieve: mockPagesRetrieve,
    },
    blocks: {
      children: {
        list: mockBlocksChildrenList,
        append: mockBlocksChildrenAppend,
      },
      delete: mockBlocksDelete,
      update: mockBlocksUpdate,
    },
  })),
}));

jest.mock('../src/config', () => ({
  NOTION_TOKEN: 'test-token',
  NOTION_DATABASE_ID: 'db-tasks',
  NOTION_PLANS_DATABASE_ID: 'db-plans',
}));

const notion = require('../src/integrations/notion');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('isConfigured / isPlansConfigured', () => {
  test('возвращает true при наличии переменных', () => {
    expect(notion.isConfigured()).toBe(true);
    expect(notion.isPlansConfigured()).toBe(true);
  });
});

describe('pushTask', () => {
  test('создаёт страницу и возвращает id', async () => {
    mockPagesCreate.mockResolvedValue({ id: 'page-abc' });

    const task = { title: 'Купить молоко', category_name: 'Общее', description: null, due_date: null, priority: null, plan_notion_page_id: null };
    const id = await notion.pushTask(task);
    expect(id).toBe('page-abc');
    expect(mockPagesCreate).toHaveBeenCalledTimes(1);
  });

  test('включает description если есть', async () => {
    mockPagesCreate.mockResolvedValue({ id: 'page-1' });

    await notion.pushTask({ title: 'Задача', description: 'Описание', category_name: 'Дом', due_date: null, priority: null, plan_notion_page_id: null });
    const props = mockPagesCreate.mock.calls[0][0].properties;
    expect(props.Description).toBeDefined();
  });

  test('включает due_date если есть', async () => {
    mockPagesCreate.mockResolvedValue({ id: 'page-2' });

    await notion.pushTask({ title: 'Задача', description: null, category_name: 'Дом', due_date: '2026-12-31', priority: null, plan_notion_page_id: null });
    const props = mockPagesCreate.mock.calls[0][0].properties;
    expect(props['Due Date']).toBeDefined();
    expect(props['Due Date'].date.start).toBe('2026-12-31');
  });

  test('включает план relation если есть plan_notion_page_id', async () => {
    mockPagesCreate.mockResolvedValue({ id: 'page-3' });

    await notion.pushTask({ title: 'Задача', description: null, category_name: 'Общее', due_date: null, priority: null, plan_notion_page_id: 'plan-page-id' });
    const props = mockPagesCreate.mock.calls[0][0].properties;
    expect(props.Plan.relation[0].id).toBe('plan-page-id');
  });
});

describe('updateTaskFields', () => {
  test('обновляет поля страницы', async () => {
    mockPagesUpdate.mockResolvedValue({});

    await notion.updateTaskFields('page-xyz', { title: 'Новое', category_name: 'Работа', description: null, due_date: null, priority: null, plan_notion_page_id: null });
    expect(mockPagesUpdate).toHaveBeenCalledWith(expect.objectContaining({ page_id: 'page-xyz' }));
    const props = mockPagesUpdate.mock.calls[0][0].properties;
    expect(props.Name.title[0].text.content).toBe('Новое');
  });

  test('не вызывает update если notionPageId не передан', async () => {
    await notion.updateTaskFields(null, { title: 'Задача', category_name: 'Общее' });
    expect(mockPagesUpdate).not.toHaveBeenCalled();
  });
});

describe('updateTaskStatus', () => {
  test('обновляет статус на In progress', async () => {
    mockPagesUpdate.mockResolvedValue({});

    await notion.updateTaskStatus('page-xyz', 'in_progress');
    const props = mockPagesUpdate.mock.calls[0][0].properties;
    expect(props.Status.status.name).toBe('In progress');
  });

  test('архивирует страницу при статусе deleted', async () => {
    mockPagesRetrieve.mockResolvedValue({ archived: false });
    mockPagesUpdate.mockResolvedValue({});

    await notion.updateTaskStatus('page-xyz', 'deleted');
    expect(mockPagesUpdate).toHaveBeenCalledWith(expect.objectContaining({ archived: true }));
  });
});

describe('pushPlan', () => {
  test('создаёт план и возвращает id', async () => {
    mockPagesCreate.mockResolvedValue({ id: 'plan-page-abc' });

    const id = await notion.pushPlan({ title: 'Ремонт', description: null });
    expect(id).toBe('plan-page-abc');
  });

  test('не передаёт Description в Notion (поля нет в базе планов)', async () => {
    mockPagesCreate.mockResolvedValue({ id: 'plan-1' });

    await notion.pushPlan({ title: 'Ремонт', description: 'Полный ремонт кухни' });
    const props = mockPagesCreate.mock.calls[0][0].properties;
    expect(props.Description).toBeUndefined();
  });

  test('возвращает null при ошибке Notion API', async () => {
    mockPagesCreate.mockRejectedValue(new Error('API error'));

    const id = await notion.pushPlan({ title: 'Ремонт', description: null });
    expect(id).toBeNull();
  });
});

describe('archiveNotionPage / unarchiveNotionPage', () => {
  test('архивирует страницу', async () => {
    mockPagesRetrieve.mockResolvedValue({ archived: false });
    mockPagesUpdate.mockResolvedValue({});

    await notion.archiveNotionPage('page-abc');
    expect(mockPagesUpdate).toHaveBeenCalledWith({ page_id: 'page-abc', archived: true });
  });

  test('не архивирует если уже архивирована', async () => {
    mockPagesRetrieve.mockResolvedValue({ archived: true });

    await notion.archiveNotionPage('page-abc');
    expect(mockPagesUpdate).not.toHaveBeenCalled();
  });

  test('восстанавливает страницу', async () => {
    mockPagesUpdate.mockResolvedValue({});

    await notion.unarchiveNotionPage('page-abc');
    expect(mockPagesUpdate).toHaveBeenCalledWith({ page_id: 'page-abc', archived: false });
  });

  test('не вызывает API если нет id', async () => {
    await notion.archiveNotionPage(null);
    expect(mockPagesUpdate).not.toHaveBeenCalled();
  });
});

describe('syncSubtasksToNotion', () => {
  test('возвращает маппинг subtaskId → blockId', async () => {
    mockBlocksChildrenList.mockResolvedValue({ results: [] });
    mockBlocksChildrenAppend.mockResolvedValue({
      results: [{ id: 'block-1' }, { id: 'block-2' }],
    });

    const subtasks = [
      { id: 10, title: 'Шаг 1', is_done: 0 },
      { id: 11, title: 'Шаг 2', is_done: 1 },
    ];
    const mapping = await notion.syncSubtasksToNotion('page-abc', subtasks);
    expect(mapping).toEqual([
      { subtaskId: 10, blockId: 'block-1' },
      { subtaskId: 11, blockId: 'block-2' },
    ]);
  });

  test('удаляет существующие блоки перед добавлением', async () => {
    mockBlocksChildrenList.mockResolvedValue({ results: [{ id: 'old-block' }] });
    mockBlocksDelete.mockResolvedValue({});
    mockBlocksChildrenAppend.mockResolvedValue({ results: [{ id: 'new-block' }] });

    await notion.syncSubtasksToNotion('page-abc', [{ id: 1, title: 'Шаг', is_done: 0 }]);
    expect(mockBlocksDelete).toHaveBeenCalledWith({ block_id: 'old-block' });
  });

  test('возвращает [] если subtasks пустой', async () => {
    mockBlocksChildrenList.mockResolvedValue({ results: [] });

    const result = await notion.syncSubtasksToNotion('page-abc', []);
    expect(result).toEqual([]);
    expect(mockBlocksChildrenAppend).not.toHaveBeenCalled();
  });
});

describe('toggleSubtaskInNotion', () => {
  test('обновляет checked в блоке', async () => {
    mockBlocksUpdate.mockResolvedValue({});

    await notion.toggleSubtaskInNotion('block-1', 1);
    expect(mockBlocksUpdate).toHaveBeenCalledWith({ block_id: 'block-1', to_do: { checked: true } });
  });

  test('не вызывает API если нет blockId', async () => {
    await notion.toggleSubtaskInNotion(null, 1);
    expect(mockBlocksUpdate).not.toHaveBeenCalled();
  });
});

describe('appendSubtaskToNotion', () => {
  test('добавляет блок и возвращает его id', async () => {
    mockBlocksChildrenAppend.mockResolvedValue({ results: [{ id: 'new-block-id' }] });

    const blockId = await notion.appendSubtaskToNotion('page-abc', { title: 'Новый шаг' });
    expect(blockId).toBe('new-block-id');
    const child = mockBlocksChildrenAppend.mock.calls[0][0].children[0];
    expect(child.to_do.rich_text[0].text.content).toBe('Новый шаг');
    expect(child.to_do.checked).toBe(false);
  });
});

describe('updateSubtaskBlockTitle', () => {
  test('обновляет текст блока', async () => {
    mockBlocksUpdate.mockResolvedValue({});

    await notion.updateSubtaskBlockTitle('block-1', 'Обновлённый шаг');
    expect(mockBlocksUpdate).toHaveBeenCalledWith({
      block_id: 'block-1',
      to_do: { rich_text: [{ type: 'text', text: { content: 'Обновлённый шаг' } }] },
    });
  });
});

describe('deleteNotionBlock', () => {
  test('удаляет блок', async () => {
    mockBlocksDelete.mockResolvedValue({});

    await notion.deleteNotionBlock('block-1');
    expect(mockBlocksDelete).toHaveBeenCalledWith({ block_id: 'block-1' });
  });

  test('не вызывает API если нет blockId', async () => {
    await notion.deleteNotionBlock(null);
    expect(mockBlocksDelete).not.toHaveBeenCalled();
  });
});
