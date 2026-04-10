# AIF Skills — Справочник по скиллам

Скиллы AI Factory — это команды вида `/aif-*`, которые запускаются в Claude Code и выполняют специализированные задачи: планирование, реализацию, code review, документацию и т.д.

## Как вызвать скилл

В чате с Claude Code напечатай `/aif-<название>`, например:

```
/aif-plan новый экран авторизации
/aif-fix
/aif-commit
```

## Список скиллов

| Скилл                                                  | Назначение                                    |
| ------------------------------------------------------ | --------------------------------------------- |
| [/aif](./aif.md)                                       | Инициализация AI Factory в проекте            |
| [/aif-plan](./aif-plan.md)                             | Планирование фичи или задачи                  |
| [/aif-implement](./aif-implement.md)                   | Реализация задач из плана                     |
| [/aif-improve](./aif-improve.md)                       | Улучшение существующего плана                 |
| [/aif-verify](./aif-verify.md)                         | Проверка что реализация соответствует плану   |
| [/aif-fix](./aif-fix.md)                               | Исправление конкретного бага                  |
| [/aif-commit](./aif-commit.md)                         | Генерация conventional commit сообщения       |
| [/aif-review](./aif-review.md)                         | Code review staged изменений или PR           |
| [/aif-docs](./aif-docs.md)                             | Генерация и обновление документации           |
| [/aif-architecture](./aif-architecture.md)             | Генерация архитектурных гайдлайнов            |
| [/aif-security-checklist](./aif-security-checklist.md) | Security audit по OWASP Top 10                |
| [/aif-evolve](./aif-evolve.md)                         | Самообучение скиллов на основе прошлых ошибок |
| [/aif-reference](./aif-reference.md)                   | Создание knowledge reference из URL/файла     |
| [/aif-roadmap](./aif-roadmap.md)                       | Управление roadmap проекта                    |
| [/aif-rules](./aif-rules.md)                           | Управление правилами и соглашениями проекта   |
| [/aif-dockerize](./aif-dockerize.md)                   | Генерация Docker конфигурации                 |
| [/aif-ci](./aif-ci.md)                                 | Настройка CI/CD pipeline                      |
| [/aif-build-automation](./aif-build-automation.md)     | Генерация Makefile / Taskfile / Justfile      |
| [/aif-skill-generator](./aif-skill-generator.md)       | Создание собственных скиллов                  |
| [/aif-best-practices](./aif-best-practices.md)         | Гайдлайны качества кода                       |
| [/aif-loop](./aif-loop.md)                             | Запуск скилла по расписанию                   |

## Система skill-context (самообучение)

Скиллы умеют накапливать знания о твоём проекте. Подробнее: [skill-context.md](./skill-context.md)

## Документация Handoff

Краткие выжимки из документации самого AIF Handoff:

| Документ                                      | Описание                                                    |
| --------------------------------------------- | ----------------------------------------------------------- |
| [Обзор](./handoff-overview.md)                | Что такое Handoff, пайплайн, режимы, быстрый старт          |
| [Быстрый старт](./handoff-getting-started.md) | Docker, установка, запуск, основные команды                 |
| [Архитектура](./handoff-architecture.md)      | Пакеты, пайплайн задач, state machine, надёжность           |
| [Конфигурация](./handoff-configuration.md)    | Env переменные, таймауты, Telegram, config.yaml             |
| [Провайдеры](./handoff-providers.md)          | Claude, Codex, OpenRouter, OpenCode, кастомные адаптеры     |
| [REST API](./handoff-api.md)                  | Эндпоинты задач, проектов, профилей, WebSocket события      |
| [MCP Sync](./handoff-mcp-sync.md)             | MCP сервер, инструменты синхронизации, двунаправленный sync |
