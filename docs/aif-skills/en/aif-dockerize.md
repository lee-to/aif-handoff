# /aif-dockerize — Docker Configuration

Analyzes the project and generates a complete Docker configuration: multi-stage Dockerfile, compose files, security hardening.

## Usage

```
/aif-dockerize
```

## What it generates

| File                     | Purpose                   |
| ------------------------ | ------------------------- |
| `Dockerfile`             | Multi-stage (dev + prod)  |
| `compose.yml`            | Base configuration        |
| `compose.override.yml`   | Dev-specific settings     |
| `compose.production.yml` | Production with hardening |
| `.dockerignore`          | Exclusions                |

## Features

- Multi-stage build — minimal prod image size
- Non-root user in production
- Health checks
- Security audit of production configuration
- Tech stack specific (Node.js, Go, Python, etc.)

## After generation

```bash
docker compose build      # verify it builds
docker compose up -d      # launch dev
```
