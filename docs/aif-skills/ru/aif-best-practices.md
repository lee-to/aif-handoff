# /aif-best-practices — Гайдлайны качества кода

Справочник по best practices для написания чистого, поддерживаемого кода. Используется другими скиллами как reference, но можно вызывать напрямую для рекомендаций.

## Использование

```
/aif-best-practices              # общий обзор
/aif-best-practices naming       # правила именования
/aif-best-practices error-handling
/aif-best-practices testing
```

## Темы

**Именование**

- Файлы: kebab-case
- Классы: PascalCase
- Функции/переменные: camelCase
- Константы: SCREAMING_SNAKE_CASE
- Булевые: `is/has/can` префикс

**Структура кода**

- Одна ответственность на модуль/функцию
- Функции до 30 строк
- Не более 3 уровней вложенности

**Error Handling**

- Всегда логировать с контекстом
- Никогда не глотать ошибки в пустом catch
- Fail fast на границах системы

**Тестирование**

- Минимум 70% coverage
- Тесты называть: `should <expected> when <condition>`
- Arrange / Act / Assert структура

**Логирование**

- Структурированные логи (JSON)
- Контекст объект первым аргументом
- Уровни: debug / info / warn / error
