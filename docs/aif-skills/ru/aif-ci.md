# /aif-ci — CI/CD конфигурация

Настраивает CI/CD pipeline для GitHub Actions или GitLab CI.

## Использование

```
/aif-ci
/aif-ci github    # только GitHub Actions
/aif-ci gitlab    # только GitLab CI
```

## Что генерирует

**GitHub Actions** (`.github/workflows/`):

- `ci.yml` — lint, test, build на каждый PR
- `deploy.yml` — деплой при merge в main

**GitLab CI** (`.gitlab-ci.yml`):

- stages: lint → test → build → deploy
- кеширование зависимостей
- service containers (БД для интеграционных тестов)

## Специфика по tech stack

Для Node.js проектов:

- `npm ci` для reproducible installs
- кеш `node_modules` по `package-lock.json`
- параллельный запуск lint и test
- coverage отчёт

## После генерации

Проверь что CI проходит на тестовом PR перед использованием в production.
