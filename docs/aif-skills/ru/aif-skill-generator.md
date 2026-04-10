# /aif-skill-generator — Создание своих скиллов

Создаёт новые скиллы для AI агентов. Генерирует полный пакет: SKILL.md, references, scripts, templates.

## Использование

```
/aif-skill-generator
/aif-skill-generator deploy   # создать скилл /deploy
```

## Что создаёт

```
.claude/skills/my-skill/
├── SKILL.md          # основной файл с workflow
├── references/       # справочные материалы
│   └── EXAMPLES.md
├── scripts/          # вспомогательные скрипты
└── templates/        # шаблоны файлов
```

## Шаблоны скиллов

| Шаблон            | Для чего                          |
| ----------------- | --------------------------------- |
| `basic`           | Простой одношаговый скилл         |
| `task`            | Многошаговый workflow с задачами  |
| `research`        | Исследование и анализ             |
| `dynamic-context` | Скилл с чтением контекста проекта |
| `visual`          | Скилл с визуальными outputs       |

## Пример — скилл для деплоя

```
/aif-skill-generator deploy
```

Создаст `/deploy` скилл который:

1. Проверяет что тесты прошли
2. Собирает production build
3. Деплоит на сервер
4. Проверяет health check

## Важно

После создания скилл появляется в `.claude/skills/` и сразу доступен как `/my-skill` в Claude Code. Не забудь добавить в `skills-lock.json` если хочешь версионировать.
