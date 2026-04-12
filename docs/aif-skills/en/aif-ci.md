# /aif-ci — CI/CD Configuration

Sets up a CI/CD pipeline for GitHub Actions or GitLab CI.

## Usage

```
/aif-ci
/aif-ci github    # GitHub Actions only
/aif-ci gitlab    # GitLab CI only
```

## What it generates

**GitHub Actions** (`.github/workflows/`):

- `ci.yml` — lint, test, build on every PR
- `deploy.yml` — deploy on merge to main

**GitLab CI** (`.gitlab-ci.yml`):

- stages: lint → test → build → deploy
- dependency caching
- service containers (DB for integration tests)

## Tech stack specifics

For Node.js projects:

- `npm ci` for reproducible installs
- `node_modules` cache by `package-lock.json`
- parallel lint and test
- coverage report

## After generation

Verify CI passes on a test PR before using in production.
