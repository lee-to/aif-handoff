# Handoff — MCP Sync Server

MCP сервер обеспечивает двунаправленную синхронизацию между Handoff и AIF инструментами через [Model Context Protocol](https://modelcontextprotocol.io).

## Транспорты

### stdio (локально)

Настройка в `.mcp.json`:

```json
{
  "mcpServers": {
    "handoff": {
      "type": "stdio",
      "command": "npx",
      "args": ["tsx", "packages/mcp/src/index.ts"],
      "cwd": "/absolute/path/to/aif-handoff",
      "env": {
        "DATABASE_URL": "/absolute/path/to/aif-handoff/data/aif.sqlite",
        "PROJECTS_DIR": "/absolute/path/to/aif-handoff/.projects"
      }
    }
  }
}
```

> Используй **абсолютные пути** — относительные не работают.

Claude Code автоматически обнаруживает сервер из `.mcp.json`.

### HTTP (Docker / удалённо)

```json
{
  "mcpServers": {
    "handoff": { "url": "http://localhost:3100/mcp" }
  }
}
```

Запуск: установи `MCP_TRANSPORT=http`. Порт по умолчанию — `3100`. Эндпоинт `/health` для healthcheck.

## Переменные окружения

| Переменная                 | По умолчанию | Описание                    |
| -------------------------- | ------------ | --------------------------- |
| `MCP_TRANSPORT`            | `stdio`      | Режим: `stdio` или `http`   |
| `MCP_PORT`                 | `3100`       | HTTP порт                   |
| `MCP_RATE_LIMIT_READ_RPM`  | `120`        | Лимит чтения (запросов/мин) |
| `MCP_RATE_LIMIT_WRITE_RPM` | `30`         | Лимит записи (запросов/мин) |

## Инструменты — Чтение

### `handoff_list_tasks`

Список задач с фильтрами. Возвращает краткие поля (без плана и логов).

| Параметр    | Тип        | Описание                                  |
| ----------- | ---------- | ----------------------------------------- |
| `projectId` | UUID       | Фильтр по проекту                         |
| `status`    | TaskStatus | Фильтр по статусу                         |
| `limit`     | number     | Макс результатов (по умолч. 20, макс 100) |
| `offset`    | number     | Пропустить N результатов                  |

### `handoff_get_task`

Получить задачу по ID с **полными данными** (план, описание, логи).

### `handoff_search_tasks`

Полнотекстовый поиск по заголовкам и описаниям.

| Параметр    | Тип    | Описание                             |
| ----------- | ------ | ------------------------------------ |
| `query`     | string | Поисковый запрос (макс 200 символов) |
| `projectId` | UUID   | Ограничить поиск проектом            |

### `handoff_list_projects`

Список всех проектов. Без параметров.

## Инструменты — Запись

### `handoff_create_task`

Создать задачу.

| Параметр      | Тип            | Описание                     |
| ------------- | -------------- | ---------------------------- |
| `projectId`   | UUID           | ID проекта (обязательно)     |
| `title`       | string         | Название (макс 500 символов) |
| `description` | string         | Описание                     |
| `priority`    | 0-3            | Приоритет                    |
| `plannerMode` | `fast`\|`full` | Режим планировщика           |

### `handoff_update_task`

Обновить существующую задачу (любые изменяемые поля).

### `handoff_sync_status`

Двунаправленная синхронизация статуса с обнаружением конфликтов.

| Параметр          | Тип                                | Описание                  |
| ----------------- | ---------------------------------- | ------------------------- |
| `taskId`          | UUID                               | ID задачи                 |
| `newStatus`       | TaskStatus                         | Желаемый статус           |
| `sourceTimestamp` | ISO string                         | Временная метка источника |
| `direction`       | `aif_to_handoff`\|`handoff_to_aif` | Направление               |
| `paused`          | boolean                            | Установить паузу атомарно |

Ответ:

```json
{
  "applied": true,
  "conflict": false,
  "task": { "id": "abc-123", "status": "in_progress" },
  "lastSyncedAt": "2026-03-31T12:00:00.123Z"
}
```

### `handoff_push_plan`

Сохранить содержимое плана в задачу (макс 100KB).

### `handoff_annotate_plan`

Вставить/обновить аннотацию задачи в план. **Не сохраняет** — используй `handoff_push_plan` для записи.

Формат аннотации:

```markdown
<!-- handoff:task:a1b2c3d4-e5f6-7890-abcd-ef1234567890 -->
```

## Разрешение конфликтов

Стратегия **last-write-wins** по миллисекундной точности:

1. `sourceTimestamp` сравнивается с `updatedAt` задачи
2. Если источник новее или равен — изменение применяется
3. Если цель новее — возвращается конфликт без изменений
4. Вызывающий сам решает как обрабатывать конфликт

## Двунаправленная синхронизация

### Режим 1: Управляется Handoff (`HANDOFF_MODE=1`)

Когда задача идёт через координатор Handoff, он управляет всеми переходами статуса напрямую. Скиллы и агенты **не вызывают** MCP инструменты.

```
Handoff Coordinator
  ├─ updateTaskStatus(id, "planning")   ← прямая запись в БД
  ├─ runPlanner(id)                      ← запускает Claude Code с env vars
  │   └─ /aif-plan видит HANDOFF_MODE=1
  │       ├─ Вставляет аннотацию в план
  │       └─ НЕ вызывает MCP (координатор управляет)
  └─ WebSocket broadcast → обновляет Kanban UI
```

### Режим 2: Ручная сессия Claude Code

Когда разработчик запускает `/aif-plan` напрямую с `HANDOFF_TASK_ID` в env, скиллы сами вызывают MCP инструменты для синхронизации.

```
Developer
  └─ /aif-plan "add user auth"
      └─ Скилл видит HANDOFF_TASK_ID но не HANDOFF_MODE
          ├─ Вызывает handoff_sync_status(newStatus: "planning")
          ├─ AskUserQuestion работает нормально (интерактивный режим)
          └─ Вызывает handoff_sync_status(newStatus: "plan_ready") после
```

### Env переменные в subprocess

| Переменная            | Описание                                       |
| --------------------- | ---------------------------------------------- |
| `HANDOFF_MODE=1`      | Координатор управляет — скиллы не вызывают MCP |
| `HANDOFF_TASK_ID`     | UUID связанной задачи                          |
| `HANDOFF_SKIP_REVIEW` | Пропустить этап ревью                          |

## Rate Limiting

- **Чтение** (list, get, search): 120 запросов/мин, burst 10
- **Запись** (create, update, sync, push): 30 запросов/мин, burst 5

Использует алгоритм token bucket. Превышение → MCP error response.

## WebSocket интеграция

При изменении задач через MCP, сервер рассылает события в WebSocket API для обновления Kanban UI в реальном времени. Рассылка — best-effort, не блокирует.
