# /aif-commit — Conventional commit

Анализирует staged изменения и создаёт коммит по спецификации [Conventional Commits](https://www.conventionalcommits.org/).

## Использование

```
/aif-commit          # автоопределение типа и scope
/aif-commit auth     # указать scope вручную
```

## Типы коммитов

| Тип        | Когда                               |
| ---------- | ----------------------------------- |
| `feat`     | Новая функциональность              |
| `fix`      | Исправление бага                    |
| `docs`     | Только документация                 |
| `refactor` | Рефакторинг без изменения поведения |
| `test`     | Тесты                               |
| `chore`    | Обслуживание, зависимости           |
| `build`    | Система сборки                      |
| `ci`       | CI/CD конфигурация                  |
| `perf`     | Улучшение производительности        |
| `style`    | Форматирование кода                 |

## Формат

```
<type>(<scope>): <subject>

<body>

<footer>
```

Пример:

```
fix(api): handle null response from payment gateway

The payment API can return null when the gateway times out.
Added null check and retry logic.

Fixes #123
```

## Workflow (интерактивный)

1. Проверяет staged файлы (`git status`)
2. Анализирует diff (`git diff --cached`)
3. Проверяет соответствие архитектуре и RULES
4. Предлагает сообщение коммита
5. **Спрашивает подтверждение** — commit as is / edit / cancel
6. Выполняет `git commit`
7. Предлагает push

> **Важно:** скилл интерактивный — требует терминала. В Handoff UI при нажатии "Approve + Create commit" используется автоматическая не-интерактивная версия.

## Правила

- Никогда не коммитит секреты и credentials
- Не добавляет строки `Co-Authored-By: AI`
- Если изменения не связаны между собой — предлагает разбить на несколько коммитов
