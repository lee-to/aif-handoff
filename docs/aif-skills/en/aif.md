# /aif — Project Initialization

Sets up AI Factory in a project from scratch: analyzes the tech stack, installs relevant skills, generates custom skills, and configures MCP servers.

**Run once when starting a project or after a major tech stack change.**

## Usage

```
/aif
```

## What it does

1. Reads `.ai-factory/DESCRIPTION.md` — learns the project's tech stack
2. Installs suitable skills from the registry (`skills.sh`)
3. Generates custom skills if needed
4. Configures MCP servers
5. Initializes the `.ai-factory/` directory structure

## Directory structure created

```
.ai-factory/
├── DESCRIPTION.md      # project description and tech stack
├── ARCHITECTURE.md     # architecture decisions
├── RULES.md            # rules and conventions
├── PLAN.md             # current plan
├── patches/            # fix patches (for aif-evolve)
├── skill-context/      # project-specific skill overrides
└── references/         # knowledge references
```

## When to use

- New project
- Connecting to an existing project for the first time
- After a significant tech stack change
