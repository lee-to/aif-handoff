# Handoff — Быстрый старт

## Требования

- **Docker** — рекомендуемый способ запуска
- Node.js 22+ и npm 10+ — для запуска без Docker
- **Claude Code CLI** — если без Docker: `npm i -g @anthropic-ai/claude-code`
- Claude подписка или Anthropic API ключ

## Запуск через Docker (рекомендуется)

```bash
git clone https://github.com/lee-to/aif-handoff.git
cd aif-handoff
docker compose up --build
```

Запускает API (порт 3009), Web UI (порт 5180) и Agent одной командой.

### Аутентификация в Docker

**Вариант А — API ключ:** создай `.env` с `ANTHROPIC_API_KEY=sk-ant-xxxxx` до запуска.

**Вариант Б — Claude подписка:**

```bash
docker compose exec agent claude login
docker compose restart
```

> Важно: URL при логине может переноситься — убери переносы строк перед вставкой в браузер.

### Production

```bash
docker compose -f docker-compose.production.yml up --build
```

Открыты только порты 80/443. Включены healthcheck, resource limits, log rotation.

## Запуск без Docker

```bash
npm i -g @anthropic-ai/claude-code
git clone https://github.com/lee-to/aif-handoff.git
cd aif-handoff
npm install
npm run db:setup
cp .env.example .env
npm run dev
```

## Сервисы

| Сервис | URL                     | Описание                     |
| ------ | ----------------------- | ---------------------------- |
| API    | `http://localhost:3009` | REST + WebSocket             |
| Web UI | `http://localhost:5180` | Kanban доска                 |
| Agent  | (фоновый)               | Опрашивает задачи каждые 30с |

## Проверка работы

1. Открой `http://localhost:5180` — должна появиться Kanban доска
2. Создай проект (селектор вверху слева)
3. Добавь задачу в колонку Backlog
4. Если авторизация настроена — задача автоматически пройдёт через этапы

```bash
# Проверка готовности агента
curl -s http://localhost:3009/agent/readiness
```

## Основные команды

| Команда            | Описание                  |
| ------------------ | ------------------------- |
| `npm run dev`      | Все сервисы с hot reload  |
| `npm run build`    | Сборка всех пакетов       |
| `npm test`         | Запуск тестов             |
| `npm run db:setup` | Инициализация SQLite      |
| `npm run db:push`  | Применить изменения схемы |
