# /aif-roadmap — Управление roadmap

Создаёт и обновляет `ROADMAP.md` с milestones, фичами и временными рамками.

## Использование

```
/aif-roadmap
/aif-roadmap update   # обновить существующую roadmap
```

## Что создаёт

Файл `.ai-factory/ROADMAP.md`:

```markdown
## Milestone 1: MVP (2026-Q1)

- [ ] feat: user authentication
- [ ] feat: basic CRUD

## Milestone 2: Beta (2026-Q2)

- [ ] feat: notifications
- [ ] perf: query optimization
```

## Зачем нужна roadmap

Скиллы `/aif-plan` и `/aif-commit` читают roadmap чтобы:

- Связывать задачи с milestone
- Добавлять milestone linkage в коммиты
- Предупреждать если фича не связана ни с одним milestone
