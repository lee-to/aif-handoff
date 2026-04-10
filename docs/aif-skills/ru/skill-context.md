# Skill-Context — Система самообучения

Skill-context — это механизм накопления проектно-специфичных правил для скиллов. Позволяет кастомизировать поведение скиллов под твой проект без изменения исходников.

## Проблема которую решает

Базовые скиллы (`/aif-commit`, `/aif-implement` и др.) написаны для общего случая. Но каждый проект имеет свои соглашения, tech stack, архитектурные решения. Skill-context позволяет зафиксировать эти знания.

## Расположение

```
.ai-factory/
└── skill-context/
    ├── aif-commit/
    │   └── SKILL.md    # правила для /aif-commit в этом проекте
    ├── aif-implement/
    │   └── SKILL.md    # правила для /aif-implement
    └── aif-fix/
        └── SKILL.md    # правила для /aif-fix
```

## Приоритет правил

```
skill-context/aif-commit/SKILL.md   ← ВЫШЕ приоритет (проектные правила)
.claude/skills/aif-commit/SKILL.md  ← НИЖЕ приоритет (базовый скилл)
```

При конфликте — **skill-context всегда побеждает**. Тот же принцип что у вложенных CLAUDE.md файлов.

## Как создаются правила

**Автоматически** — через `/aif-evolve`:

```
/aif-fix баг с авторизацией   → создаёт patch
/aif-evolve aif-fix           → анализирует patch → добавляет правило в skill-context
```

**Вручную** — можно редактировать `.ai-factory/skill-context/<skill>/SKILL.md` напрямую:

```markdown
# Project Rules for /aif-commit

## Rules

### Always include ticket number

**Source**: team convention
**Rule**: If branch name contains JIRA ticket (e.g. PROJ-123), always include it in commit footer as `Refs: PROJ-123`
```

## Обновление aif не затирает skill-context

Когда выходит новая версия AI Factory и ты обновляешь скиллы — файлы в `.ai-factory/skill-context/` **не трогаются**. Базовые скиллы в `.claude/skills/` обновятся, твои правила останутся.

## Пример реального использования

Допустим `/aif-commit` несколько раз генерировал коммиты без scope, а в проекте это обязательно. После `/aif-fix` создаётся патч, после `/aif-evolve aif-commit` в skill-context появляется:

```markdown
### Scope is mandatory in this project

**Source**: patches/2026-04-01.md
**Rule**: Always include scope in commit message. The project follows strict conventional commits — commits without scope will be rejected in CI.
```

Теперь `/aif-commit` всегда будет включать scope.

## Просмотр текущих правил

```bash
cat .ai-factory/skill-context/aif-commit/SKILL.md
ls .ai-factory/skill-context/
```
