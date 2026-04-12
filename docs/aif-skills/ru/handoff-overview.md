# AIF Handoff — Обзор

> Автономная Kanban-доска где AI агенты планируют, реализуют и проверяют твои задачи — полностью без участия человека.

> Проект построен с использованием [AI Factory](https://github.com/lee-to/ai-factory) — open-source фреймворка для AI-driven разработки.

Задачи проходят через этапы автоматически: **Backlog → Planning → Plan Ready → Implementing → Review → Done** — каждый этап оркестрируется специализированными AI субагентами. В авто-режиме ревью может автоматически запускать повторную реализацию: **Review → request_changes → Implementing**.

## Провайдеры из коробки

| Провайдер                     | Транспорты    |
| ----------------------------- | ------------- |
| **Claude** (`anthropic`)      | SDK, CLI, API |
| **Codex** (`openai`)          | SDK, CLI, API |
| **OpenRouter** (`openrouter`) | API           |
| **OpenCode** (`opencode`)     | API           |

> **⚠️ Предупреждение:** Anthropic запрещает использование подписок Claude Max / Pro за пределами официального Claude Code CLI. SDK транспорт для Claude вызывает Agent SDK напрямую, что может нарушать условия использования. Используй API транспорт с `ANTHROPIC_API_KEY` для production.

Нужно своё? Добавь кастомный runtime адаптер и загрузи через `AIF_RUNTIME_MODULES`. Форк не требуется.

## Ключевые возможности

- **Полностью автономный пайплайн** — создай задачу, AI планирует, реализует и проверяет её
- **Kanban UI** — доска с реалтайм WebSocket обновлениями
- **AI Factory core** — построен на [ai-factory](https://github.com/lee-to/ai-factory) определениях агентов и системе скиллов
- **Оркестрация субагентов** — plan-coordinator, implement-coordinator, review + security sidecars
- **Модульность провайдеров** — runtime реестр, выбор профиля на уровне проекта/задачи
- **Self-healing пайплайн** — heartbeat + watchdog автоматически восстанавливает зависшие этапы
- **Human-in-the-loop** — одобряй планы, запрашивай правки или дай авто-режиму всё делать самому
- **MCP sync** — двунаправленная синхронизация задач между Handoff и AIF инструментами

## Пайплайн агентов

| Этап                 | Агент                                 | Что делает                                        |
| -------------------- | ------------------------------------- | ------------------------------------------------- |
| Backlog → Plan Ready | `plan-coordinator`                    | Итеративное улучшение плана через `plan-polisher` |
| Plan Ready → Review  | `implement-coordinator`               | Параллельное выполнение с quality sidecars        |
| Review → Done        | `review-sidecar` + `security-sidecar` | Code review и security audit параллельно          |

## Режимы выполнения

| Режим         | `AGENT_USE_SUBAGENTS` | Описание                                                                                                  |
| ------------- | --------------------- | --------------------------------------------------------------------------------------------------------- |
| **Субагенты** | `true` (по умолч.)    | Каждый этап через специализированные координаторы с итеративным улучшением. Выше качество, больше токенов |
| **Скиллы**    | `false`               | Один проход через aif-\* скиллы. Быстрее и дешевле, без итерации                                          |

## Быстрый старт

```bash
# Без Docker
git clone https://github.com/lee-to/aif-handoff.git
cd aif-handoff
npm install && npm run init && npm run dev

# С Docker
docker compose up --build
```

| Сервис | URL                     | Описание                     |
| ------ | ----------------------- | ---------------------------- |
| API    | `http://localhost:3009` | Hono REST + WebSocket        |
| Web UI | `http://localhost:5180` | React Kanban доска           |
| Agent  | _(фоновый)_             | Опрашивает задачи каждые 30с |

Подробнее: [Быстрый старт](./handoff-getting-started.md)
