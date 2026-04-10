# Handoff — Конфигурация

Всё через переменные окружения. Скопируй `.env.example` в `.env`.

## Основные переменные

| Переменная                 | По умолчанию        | Описание                                           |
| -------------------------- | ------------------- | -------------------------------------------------- |
| `ANTHROPIC_API_KEY`        | —                   | API ключ Anthropic (или используй `claude login`)  |
| `PORT`                     | `3009`              | Порт API сервера                                   |
| `WEB_PORT`                 | `5180`              | Порт Web UI (Vite)                                 |
| `DATABASE_URL`             | `./data/aif.sqlite` | Путь к SQLite базе                                 |
| `AGENT_BYPASS_PERMISSIONS` | `true`              | Автоодобрение всех действий агента                 |
| `AGENT_USE_SUBAGENTS`      | `true`              | `true` = кастомные агенты, `false` = aif-\* скиллы |
| `POLL_INTERVAL_MS`         | `30000`             | Интервал опроса координатора (мс)                  |
| `LOG_LEVEL`                | `debug`             | Уровень логирования                                |

## Таймауты

| Переменная                        | По умолчанию | Описание                                |
| --------------------------------- | ------------ | --------------------------------------- |
| `AGENT_STAGE_STALE_TIMEOUT_MS`    | `5400000`    | Таймаут зависшей задачи (90 мин)        |
| `AGENT_STAGE_RUN_TIMEOUT_MS`      | `3600000`    | Максимум на один этап (60 мин)          |
| `AGENT_FIRST_ACTIVITY_TIMEOUT_MS` | `60000`      | Watchdog первой активности (60 сек)     |
| `API_RUNTIME_RUN_TIMEOUT_MS`      | `120000`     | Таймаут одноразовых API вызовов (2 мин) |

## AI провайдеры

| Переменная            | Описание                               |
| --------------------- | -------------------------------------- |
| `OPENAI_API_KEY`      | Для Codex/OpenAI адаптеров             |
| `OPENROUTER_API_KEY`  | Для OpenRouter адаптера                |
| `AIF_RUNTIME_MODULES` | Внешние runtime модули (через запятую) |

## Разрешения агента

**Простой способ** — `AGENT_BYPASS_PERMISSIONS=true` (по умолчанию). Все инструменты одобряются автоматически.

**Гранулярный** — `AGENT_BYPASS_PERMISSIONS=false` + allow rules в `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["Bash(npm run:*)", "Bash(git:*)"]
  }
}
```

## Telegram уведомления

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_USER_ID=987654321
```

Получи `TELEGRAM_USER_ID` от [@userinfobot](https://t.me/userinfobot).

## Конфигурация проекта (config.yaml)

Файл `.ai-factory/config.yaml` в корне проекта переопределяет пути и поведение для конкретного проекта. Редактируется через **Global Settings** (иконка шестерёнки в хедере).

### Язык AI артефактов

```yaml
language:
  ui: ru # язык интерфейса агента
  artifacts: ru # язык генерируемых документов
```

### Кастомные пути

```yaml
paths:
  plan: .ai-factory/PLAN.md
  description: .ai-factory/DESCRIPTION.md
  architecture: .ai-factory/ARCHITECTURE.md
```

### Git настройки

```yaml
git:
  base_branch: main
  create_branches: true
  branch_prefix: feature/
  skip_push_after_commit: false
```
