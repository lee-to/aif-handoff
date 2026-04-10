# Handoff — Провайдеры (Runtime)

## Поддерживаемые рантаймы

| Runtime      | Провайдер    | Транспорты    | Resume       | Agent Definitions |
| ------------ | ------------ | ------------- | ------------ | ----------------- |
| `claude`     | `anthropic`  | SDK, CLI, API | Да (SDK/CLI) | Да (SDK/CLI)      |
| `codex`      | `openai`     | SDK, CLI, API | Да (SDK)     | Нет               |
| `openrouter` | `openrouter` | API           | Нет          | Нет               |
| `opencode`   | `opencode`   | API           | Да           | Нет               |
| Custom       | Любой        | Любой         | Настраиваемо | Настраиваемо      |

## Типы транспортов

| Транспорт | Описание                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------- |
| `sdk`     | In-process вызов JS SDK. Стримит события в реальном времени. Поддерживает watchdog первой активности |
| `cli`     | Запуск subprocess. Нет промежуточных событий — только старт/завершение                               |
| `api`     | HTTP POST к удалённому эндпоинту. Аналогично CLI по наблюдаемости                                    |

## Настройка профилей

Профили создаются через кнопку **RUNTIME** в хедере. Хранятся в SQLite, секреты — только в env переменных.

### Claude (SDK) — рекомендуется

```json
{
  "runtimeId": "claude",
  "transport": "sdk",
  "apiKeyEnvVar": "ANTHROPIC_API_KEY",
  "defaultModel": "sonnet"
}
```

### Claude (CLI)

```json
{
  "runtimeId": "claude",
  "transport": "cli",
  "defaultModel": "claude-sonnet-4-5"
}
```

Авторизация через `claude login` в CLI.

### OpenRouter

```json
{
  "runtimeId": "openrouter",
  "transport": "api",
  "apiKeyEnvVar": "OPENROUTER_API_KEY",
  "defaultModel": "anthropic/claude-sonnet-4"
}
```

Формат моделей: `provider/model` (например `openai/gpt-4o`, `google/gemini-2.0-flash-001`). Бесплатные модели с суффиксом `:free`.

### Codex (SDK)

```json
{
  "runtimeId": "codex",
  "transport": "sdk",
  "defaultModel": "gpt-5.4"
}
```

### OpenCode (API)

```json
{
  "runtimeId": "opencode",
  "transport": "api",
  "baseUrl": "http://127.0.0.1:4096",
  "defaultModel": "anthropic/claude-sonnet-4"
}
```

Запуск: `opencode serve --hostname 127.0.0.1 --port 4096`

## Приоритет профилей

1. Профиль конкретной задачи (`tasks.runtime_profile_id`)
2. Профиль проекта по умолчанию
3. Системный default

## Кастомный адаптер

```typescript
export function registerRuntimeModule(registry) {
  registry.registerRuntime({
    descriptor: {
      id: "my-runtime",
      providerId: "my-provider",
      displayName: "My Runtime",
      capabilities: {
        supportsResume: false,
        supportsAgentDefinitions: false,
        supportsStreaming: true,
        // ...
      },
    },
    async run(input) {
      return { outputText: "ok", sessionId: null, usage: null };
    },
  });
}
```

Подключить через `AIF_RUNTIME_MODULES=./my-adapter.js`.
