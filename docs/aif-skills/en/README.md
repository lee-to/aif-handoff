# AIF Skills — Reference Guide

AI Factory skills are `/aif-*` commands that run inside Claude Code and perform specialized tasks: planning, implementation, code review, documentation, and more.

## How to invoke a skill

Type `/aif-<name>` in your Claude Code chat, for example:

```
/aif-plan new authorization screen
/aif-fix
/aif-commit
```

## Skills list

| Skill                                                  | Purpose                                     |
| ------------------------------------------------------ | ------------------------------------------- |
| [/aif](./aif.md)                                       | Initialize AI Factory in a project          |
| [/aif-plan](./aif-plan.md)                             | Plan a feature or task                      |
| [/aif-implement](./aif-implement.md)                   | Implement tasks from the plan               |
| [/aif-improve](./aif-improve.md)                       | Improve an existing plan                    |
| [/aif-verify](./aif-verify.md)                         | Verify implementation matches the plan      |
| [/aif-fix](./aif-fix.md)                               | Fix a specific bug                          |
| [/aif-commit](./aif-commit.md)                         | Generate a conventional commit message      |
| [/aif-review](./aif-review.md)                         | Code review of staged changes or PR         |
| [/aif-docs](./aif-docs.md)                             | Generate and update documentation           |
| [/aif-architecture](./aif-architecture.md)             | Generate architecture guidelines            |
| [/aif-security-checklist](./aif-security-checklist.md) | Security audit based on OWASP Top 10        |
| [/aif-evolve](./aif-evolve.md)                         | Self-improve skills based on past mistakes  |
| [/aif-reference](./aif-reference.md)                   | Create knowledge references from URLs/files |
| [/aif-roadmap](./aif-roadmap.md)                       | Manage project roadmap                      |
| [/aif-rules](./aif-rules.md)                           | Manage project rules and conventions        |
| [/aif-dockerize](./aif-dockerize.md)                   | Generate Docker configuration               |
| [/aif-ci](./aif-ci.md)                                 | Set up CI/CD pipeline                       |
| [/aif-build-automation](./aif-build-automation.md)     | Generate Makefile / Taskfile / Justfile     |
| [/aif-skill-generator](./aif-skill-generator.md)       | Create custom skills                        |
| [/aif-best-practices](./aif-best-practices.md)         | Code quality guidelines                     |
| [/aif-loop](./aif-loop.md)                             | Run a skill on a recurring interval         |

## Skill-context system (self-learning)

Skills can accumulate knowledge about your project. See: [skill-context.md](./skill-context.md)

## Handoff Documentation

Summaries of AIF Handoff's own documentation:

| Document                                        | Description                                          |
| ----------------------------------------------- | ---------------------------------------------------- |
| [Overview](./handoff-overview.md)               | What Handoff is, pipeline, modes, quick start        |
| [Getting Started](./handoff-getting-started.md) | Docker, installation, running, core commands         |
| [Architecture](./handoff-architecture.md)       | Packages, task pipeline, state machine, reliability  |
| [Configuration](./handoff-configuration.md)     | Env variables, timeouts, Telegram, config.yaml       |
| [Providers](./handoff-providers.md)             | Claude, Codex, OpenRouter, OpenCode, custom adapters |
| [REST API](./handoff-api.md)                    | Task, project, profile endpoints, WebSocket events   |
| [MCP Sync](./handoff-mcp-sync.md)               | MCP server, sync tools, bidirectional sync           |
