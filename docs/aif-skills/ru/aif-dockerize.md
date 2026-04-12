# /aif-dockerize — Docker конфигурация

Анализирует проект и генерирует полную Docker конфигурацию: multi-stage Dockerfile, compose файлы, security hardening.

## Использование

```
/aif-dockerize
```

## Что генерирует

| Файл                     | Назначение                |
| ------------------------ | ------------------------- |
| `Dockerfile`             | Multi-stage (dev + prod)  |
| `compose.yml`            | Базовая конфигурация      |
| `compose.override.yml`   | Dev-специфичные настройки |
| `compose.production.yml` | Production с hardening    |
| `.dockerignore`          | Исключения                |

## Особенности

- Multi-stage build — минимальный размер prod образа
- Non-root user в production
- Health checks
- Security audit production конфигурации
- Специфично для tech stack (Node.js, Go, Python и т.д.)

## После генерации

```bash
docker compose build      # проверить что собирается
docker compose up -d      # запустить dev
```
