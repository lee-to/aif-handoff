# /aif-build-automation — Build automation

Генерирует или улучшает файлы сборки: Makefile, Taskfile.yml, Justfile, Magefile.go.

## Использование

```
/aif-build-automation
/aif-build-automation makefile    # только Makefile
/aif-build-automation taskfile    # только Taskfile.yml
```

## Что генерирует

Анализирует `package.json` scripts, существующие команды и создаёт unified build файл с targets:

```makefile
dev:        # запуск dev сервера
build:      # production сборка
test:       # запуск тестов
lint:       # линтинг
clean:      # очистка артефактов
docker-up:  # запуск через docker compose
```

## Какой формат выбрать

| Формат         | Когда                          |
| -------------- | ------------------------------ |
| `Makefile`     | Универсально, есть везде       |
| `Taskfile.yml` | Более читаемый, cross-platform |
| `Justfile`     | Современная альтернатива Make  |
| `Magefile.go`  | Go проекты                     |

## Если файл уже существует

Скилл улучшает существующий файл — добавляет недостающие targets, исправляет best practices, не ломает то что уже работает.
