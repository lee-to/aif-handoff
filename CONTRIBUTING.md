# Contributing to AIF Handoff

Thank you for your interest in contributing! This guide will help you get started.

## Getting Started

1. Fork the repository on GitHub
2. Clone your fork:
   ```bash
   git clone https://github.com/<your-username>/aif-handoff.git
   cd aif-handoff
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Set up the database:
   ```bash
   npm run db:setup
   ```
5. Start the development environment:
   ```bash
   npm run dev
   ```

## Development Workflow

1. Create a branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```
2. Make your changes
3. Run tests and linter:
   ```bash
   npm test
   npm run lint
   ```
4. Commit using [Conventional Commits](https://www.conventionalcommits.org/):
   ```
   feat: add new task filtering
   fix: resolve WebSocket reconnection issue
   docs: update API reference
   ```
5. Push and open a pull request against `main`

## Project Structure

The project is a Turborepo monorepo with four packages:

| Package            | Description                                            |
| ------------------ | ------------------------------------------------------ |
| `packages/shared`  | Types, DB schema, state machine, constants             |
| `packages/api`     | Hono REST + WebSocket server                           |
| `packages/web`     | React Kanban UI                                        |
| `packages/runtime` | Pluggable AI provider adapters (Claude, Codex, custom) |
| `packages/agent`   | Runtime-neutral coordinator + subagent orchestration   |

See [docs/architecture.md](docs/architecture.md) for detailed architecture information.

## Code Quality

- **Test coverage:** Every package must maintain at least 70% test coverage
- **Linting:** All code must pass `npm run lint`
- **Testing:** All tests must pass via `npm test`
- **Type safety:** No `any` types unless absolutely necessary

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Include tests for new functionality
- Update documentation if behavior changes
- Reference related issues in the PR description

## Reporting Issues

- Use [GitHub Issues](https://github.com/lee-to/aif-handoff/issues) for bugs and feature requests
- Include reproduction steps for bugs
- For security vulnerabilities, see [SECURITY.md](SECURITY.md)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
