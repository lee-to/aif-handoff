# /aif-security-checklist — Security audit

Проводит security audit по OWASP Top 10 и best practices. Результат — детальный отчёт с находками.

## Использование

```
/aif-security-checklist
/aif-security-checklist auth     # фокус на конкретной области
```

## Что проверяет

| Область         | Что ищет                                                     |
| --------------- | ------------------------------------------------------------ |
| Authentication  | Слабые пароли, отсутствие rate limiting, небезопасные сессии |
| Injection       | SQL injection, command injection, XSS                        |
| Secrets         | Хардкоженные ключи, credentials в коде/логах                 |
| API Security    | Отсутствие валидации, открытые эндпоинты                     |
| Dependencies    | Уязвимые пакеты (npm audit)                                  |
| CSRF            | Отсутствие токенов для state-changing запросов               |
| Race Conditions | Параллельные запросы, TOCTOU уязвимости                      |

## Результат

Отчёт с находками по severity:

- `CRITICAL` — немедленно исправить
- `HIGH` — исправить до следующего релиза
- `MEDIUM` — исправить в ближайшем спринте
- `LOW` — рекомендация

## Когда запускать

- Перед production релизом
- После добавления auth/payment функционала
- Периодически (раз в месяц)
