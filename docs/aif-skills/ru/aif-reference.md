# /aif-reference — Knowledge reference

Создаёт structured knowledge reference из URL, документа или файла. Агенты используют эти референсы при планировании и реализации.

## Использование

```
/aif-reference https://docs.stripe.com/api
/aif-reference ./openapi.yaml
/aif-reference https://github.com/org/repo/blob/main/README.md
```

## Что делает

1. Fetches контент из URL или читает файл
2. Структурирует в markdown с метаданными
3. Сохраняет в `.ai-factory/references/`
4. Референс становится доступен для всех скиллов

## Результат

```
.ai-factory/references/
└── stripe-api.md        # структурированная документация Stripe API
```

## Когда использовать

- Добавляешь интеграцию со сторонним сервисом
- Нужно чтобы агент знал специфику внешнего API
- Документация SDK которую нужно учитывать при реализации

## Примеры

```
/aif-reference https://hono.dev/docs/api/routing
/aif-reference https://orm.drizzle.team/docs/select
```
