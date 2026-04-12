# Handoff — Архитектура

## Обзор

AIF Handoff — Turborepo монорепо из 6 пакетов. React Kanban UI позволяет создавать задачи, API и Agent работают через централизованный data layer на SQLite, выполнение AI через `@aif/runtime` — провайдеро-нейтральное.

```
Web (React) ←──HTTP/WS──► API (Hono)
                               │
Runtime adapters ◄────────► Agent
                               │
                          @aif/runtime
                               │
                          @aif/data
                               │
                           SQLite
```

## Пакеты

| Пакет          | Назначение                                          |
| -------------- | --------------------------------------------------- |
| `@aif/shared`  | Типы, схема, state machine, logger                  |
| `@aif/runtime` | Pluggable AI провайдеры (Claude, Codex, OpenRouter) |
| `@aif/data`    | Централизованный доступ к БД                        |
| `@aif/api`     | Hono REST + WebSocket (порт 3009)                   |
| `@aif/web`     | React Kanban UI (порт 5180)                         |
| `@aif/agent`   | Координатор + оркестрация субагентов                |

## Пайплайн задачи

```
Backlog → Planning → Plan Ready → Implementing → Review → Done → Verified
```

| Переход              | Агент                                 | Описание                                   |
| -------------------- | ------------------------------------- | ------------------------------------------ |
| Backlog → Plan Ready | `plan-coordinator`                    | Итеративная разработка плана               |
| Plan Ready → Review  | `implement-coordinator`               | Параллельное выполнение + quality sidecars |
| Review → Done        | `review-sidecar` + `security-sidecar` | Code review и security audit параллельно   |

## State Machine

| Статус             | Действия пользователя                                    |
| ------------------ | -------------------------------------------------------- |
| `backlog`          | `start_ai`                                               |
| `plan_ready`       | `start_implementation`, `request_replanning`, `fast_fix` |
| `blocked_external` | `retry_from_blocked`                                     |
| `done`             | `approve_done`, `request_changes`                        |
| `verified`         | (финальный статус)                                       |

## Надёжность

- **First-activity watchdog** — если агент не делает tool call за 60с после старта, перезапускается (до 2 раз)
- **Heartbeat** — задачи обновляют `lastHeartbeatAt` во время работы
- **Stale watchdog** — задачи застрявшие в planning/implementing/review дольше таймаута автоматически переводятся в `blocked_external`

## Параллельное выполнение (экспериментально)

Включается в настройках проекта. До `COORDINATOR_MAX_CONCURRENT_TASKS` (по умолчанию 3) задач выполняются одновременно. Задачи атомарно захватываются через `lockedBy`/`lockedUntil` чтобы избежать дублирования.

## Realtime обновления

WebSocket на `/ws` рассылает события всем клиентам:

| Событие        | Триггер                             |
| -------------- | ----------------------------------- |
| `task:created` | Создана задача                      |
| `task:updated` | Обновлены поля задачи               |
| `task:moved`   | Изменился статус                    |
| `task:deleted` | Задача удалена                      |
| `agent:wake`   | Координатор должен проверить работу |
