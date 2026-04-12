# /aif-build-automation — Build Automation

Generates or improves build files: Makefile, Taskfile.yml, Justfile, Magefile.go.

## Usage

```
/aif-build-automation
/aif-build-automation makefile    # Makefile only
/aif-build-automation taskfile    # Taskfile.yml only
```

## What it generates

Analyzes `package.json` scripts, existing commands, and creates a unified build file with targets:

```makefile
dev:        # start dev server
build:      # production build
test:       # run tests
lint:       # linting
clean:      # clean artifacts
docker-up:  # launch via docker compose
```

## Which format to choose

| Format         | When                            |
| -------------- | ------------------------------- |
| `Makefile`     | Universal, available everywhere |
| `Taskfile.yml` | More readable, cross-platform   |
| `Justfile`     | Modern Make alternative         |
| `Magefile.go`  | Go projects                     |

## If a file already exists

The skill improves the existing file — adds missing targets, fixes best practices, doesn't break what already works.
