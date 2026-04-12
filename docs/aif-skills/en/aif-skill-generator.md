# /aif-skill-generator — Create Custom Skills

Creates new skills for AI agents. Generates a complete package: SKILL.md, references, scripts, templates.

## Usage

```
/aif-skill-generator
/aif-skill-generator deploy   # create /deploy skill
```

## What it creates

```
.claude/skills/my-skill/
├── SKILL.md          # main file with workflow
├── references/       # reference materials
│   └── EXAMPLES.md
├── scripts/          # helper scripts
└── templates/        # file templates
```

## Skill templates

| Template          | For what                         |
| ----------------- | -------------------------------- |
| `basic`           | Simple single-step skill         |
| `task`            | Multi-step workflow with tasks   |
| `research`        | Research and analysis            |
| `dynamic-context` | Skill that reads project context |
| `visual`          | Skill with visual outputs        |

## Example — deploy skill

```
/aif-skill-generator deploy
```

Will create a `/deploy` skill that:

1. Verifies tests passed
2. Builds a production build
3. Deploys to the server
4. Checks the health check

## Important

After creation the skill appears in `.claude/skills/` and is immediately available as `/my-skill` in Claude Code. Don't forget to add to `skills-lock.json` if you want to version it.
