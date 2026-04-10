# Handoff — REST API

Base URL: `http://localhost:3009`. Все ответы — JSON.

## Система

```
GET /health              → { status, uptime }
GET /agent/readiness     → { ready, hasApiKey, hasClaudeAuth, authSource }
```

`authSource`: `api_key` | `claude_profile` | `both` | `none`

## Проекты

| Метод    | Путь                           | Описание                             |
| -------- | ------------------------------ | ------------------------------------ |
| `GET`    | `/projects`                    | Список проектов                      |
| `POST`   | `/projects`                    | Создать проект                       |
| `PUT`    | `/projects/:id`                | Обновить проект                      |
| `DELETE` | `/projects/:id`                | Удалить проект                       |
| `GET`    | `/projects/:id/roadmap/status` | Существует ли `ROADMAP.md`           |
| `POST`   | `/projects/:id/roadmap/import` | Импортировать задачи из `ROADMAP.md` |
| `GET`    | `/projects/:id/mcp`            | Получить `.mcp.json` проекта         |

### Поля проекта

| Поле                        | Тип    | Описание                      |
| --------------------------- | ------ | ----------------------------- |
| `name`                      | string | Название (1-200 символов)     |
| `rootPath`                  | string | Абсолютный путь к проекту     |
| `plannerMaxBudgetUsd`       | number | Лимит бюджета планировщика    |
| `implementerMaxBudgetUsd`   | number | Лимит бюджета имплементатора  |
| `reviewSidecarMaxBudgetUsd` | number | Лимит бюджета сайдкаров ревью |

### Импорт Roadmap

```
POST /projects/:id/roadmap/import
Body: { "roadmapAlias": "v1.0" }
```

Читает `.ai-factory/ROADMAP.md`, конвертирует вехи в задачи, дедублирует по `projectId + title + alias`.

Теги автоматически: `roadmap`, `rm:<alias>`, `phase:<N>`, `seq:<NN>`.

Ответ:

```json
{
  "roadmapAlias": "v1.0",
  "created": 5,
  "skipped": 2,
  "taskIds": ["uuid-1", "..."],
  "byPhase": { "1": { "created": 3, "skipped": 1 } }
}
```

> Может занять 30-120 секунд из-за обработки Agent SDK.

## Задачи

| Метод    | Путь                                                   | Описание                     |
| -------- | ------------------------------------------------------ | ---------------------------- |
| `GET`    | `/tasks?projectId=<uuid>`                              | Список задач                 |
| `POST`   | `/tasks`                                               | Создать задачу               |
| `GET`    | `/tasks/:id`                                           | Получить задачу              |
| `PUT`    | `/tasks/:id`                                           | Обновить задачу              |
| `DELETE` | `/tasks/:id`                                           | Удалить задачу               |
| `POST`   | `/tasks/:id/action`                                    | Выполнить переход состояния  |
| `GET`    | `/tasks/:id/attachments/:filename`                     | Скачать вложение             |
| `GET`    | `/tasks/:id/comments/:commentId/attachments/:filename` | Скачать вложение комментария |

### Поля при создании задачи

| Поле           | Тип      | По умолчанию | Описание                             |
| -------------- | -------- | ------------ | ------------------------------------ |
| `projectId`    | string   | —            | UUID проекта                         |
| `title`        | string   | —            | Название (1-500 символов)            |
| `description`  | string   | `""`         | Описание                             |
| `priority`     | integer  | `0`          | Приоритет (0-5)                      |
| `autoMode`     | boolean  | `true`       | Авто-продвижение по этапам           |
| `isFix`        | boolean  | `false`      | Задача-фикс (использует FIX_PLAN)    |
| `skipReview`   | boolean  | `false`      | Пропустить ревью                     |
| `paused`       | boolean  | `false`      | Пауза обработки                      |
| `useSubagents` | boolean  | `true`       | Кастомные субагенты vs aif-\* скиллы |
| `tags`         | string[] | `[]`         | Теги (макс 50)                       |
| `roadmapAlias` | string   | `null`       | Группировка по Roadmap               |

### Действия над задачей

```
POST /tasks/:id/action
Body: { "action": "<action_name>" }
```

| Действие               | Условие               |
| ---------------------- | --------------------- |
| `start_ai`             | из `backlog`          |
| `start_implementation` | из `plan_ready`       |
| `request_replanning`   | из `plan_ready`       |
| `fast_fix`             | из `plan_ready`       |
| `approve_done`         | из `done`             |
| `request_changes`      | из `done`             |
| `retry_from_blocked`   | из `blocked_external` |

## Профили Runtime

| Метод    | Путь                          | Описание                 |
| -------- | ----------------------------- | ------------------------ |
| `GET`    | `/runtime-profiles`           | Список профилей          |
| `POST`   | `/runtime-profiles`           | Создать профиль          |
| `PUT`    | `/runtime-profiles/:id`       | Обновить профиль         |
| `DELETE` | `/runtime-profiles/:id`       | Удалить профиль          |
| `GET`    | `/runtime-profiles/models`    | Список доступных моделей |
| `GET`    | `/runtime-profiles/readiness` | Проверка готовности      |

## Чат (One-shot)

```
POST /chat
Body: { "projectId": "uuid", "message": "текст", "profileId": "uuid" }
Response: { "content": "ответ", "usage": { "input_tokens": N, "output_tokens": N } }
```

Одноразовый запрос к AI без сохранения контекста.

## WebSocket

```
ws://localhost:3009/ws
```

| Событие        | Триггер                             |
| -------------- | ----------------------------------- |
| `task:created` | Создана задача                      |
| `task:updated` | Обновлены поля                      |
| `task:moved`   | Изменился статус                    |
| `task:deleted` | Задача удалена                      |
| `agent:wake`   | Координатор должен проверить работу |

Формат сообщений:

```json
{ "type": "task:updated", "data": { "id": "uuid", "status": "implementing" } }
```
