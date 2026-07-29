# ---- Base ----
FROM node:22-slim AS base
WORKDIR /app
# Proxy (optional) — propagated to all downstream stages via ENV,
# so apt-get / npm / npx all pick it up during build.
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG ALL_PROXY
ARG NO_PROXY
ENV HTTP_PROXY=${HTTP_PROXY} \
    HTTPS_PROXY=${HTTPS_PROXY} \
    ALL_PROXY=${ALL_PROXY} \
    NO_PROXY=${NO_PROXY} \
    http_proxy=${HTTP_PROXY} \
    https_proxy=${HTTPS_PROXY} \
    all_proxy=${ALL_PROXY} \
    no_proxy=${NO_PROXY}
# Resilient apt wrapper — retries on transient mirror/CDN failures (Hash Sum
# mismatch, sporadic 5xx). See script header for details. Available to all
# Debian-based downstream stages (deps, build, api, agent, mcp).
COPY .docker/apt-install.sh /usr/local/bin/apt-install
RUN chmod +x /usr/local/bin/apt-install

FROM base AS codex
ARG CODEX_VERSION=0.145.0
RUN npm install --prefix /opt/codex --ignore-scripts --no-save --package-lock=false "@openai/codex-sdk@${CODEX_VERSION}"

# ---- Dependencies ----
FROM base AS deps
COPY package.json package-lock.json turbo.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/data/package.json packages/data/
COPY packages/runtime/package.json packages/runtime/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
COPY packages/agent/package.json packages/agent/
COPY packages/mcp/package.json packages/mcp/
# Native modules (better-sqlite3) ship prebuilt binaries via prebuild-install.
# When the prebuild fetch times out (intermittent npm registry / GitHub
# releases slowness), npm falls back to `node-gyp rebuild`, which needs
# python3 + build-essential — neither present in node:22-slim. Without those
# the build fails with a misleading "Python is not set" error. Install the
# build toolchain upfront and raise npm fetch retries. apt-install handles
# transient mirror failures and cleans /var/lib/apt/lists/* on exit.
RUN apt-install python3 build-essential ca-certificates
RUN npm config set fetch-retries 5 \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && npm ci --ignore-scripts
RUN rm -rf /app/node_modules/@openai /app/node_modules/.bin/codex
COPY --from=codex /opt/codex/node_modules/@openai ./node_modules/@openai
COPY --from=codex /opt/codex/node_modules/.bin/codex ./node_modules/.bin/codex
RUN npm rebuild

# ---- Build ----
FROM deps AS build
COPY . .
RUN npm run codex:app-server:protocol:generate --workspace=@aif/runtime
RUN npx turbo build

# ---- App (api / agent / mcp share one image, differ only by command) ----
FROM base AS app
ENV NODE_ENV=production \
    HOME=/home/node \
    CODEX_CLI_PATH=/app/node_modules/.bin/codex \
    PATH=/app/node_modules/.bin:${PATH}
# Test toolchain versions (PHP via sury.org, Go via go.dev tarball). Override at
# build time with --build-arg PHP_VERSION=... / GO_VERSION=...
ARG PHP_VERSION=8.4
ARG GO_VERSION=1.24.4
# jq / python3 back the consumer repo's edit-time and commit-time gates that run
# inside this container: jq parses the hook stdin payload (nearly every PostToolUse hook
# shells out to it), python3 backs the pre-commit JSON + YAML validity checks, and gh
# backs spec validation. When absent, those gates do not fail — they SKIP, staying
# registered while enforcing nothing, which reads as a pass in any settings audit.
# Diagnosed 2026-07-23 by a parity audit run live inside this image.
RUN apt-install gosu git curl ca-certificates openssh-client jq python3 \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-install gh \
    && npm i -g @anthropic-ai/claude-code
# PHP + Go so subagents/fastFix can run tests for user projects in /home/www.
COPY .docker/install-test-toolchains.sh /usr/local/bin/install-test-toolchains
RUN chmod +x /usr/local/bin/install-test-toolchains \
    && PHP_VERSION="${PHP_VERSION}" GO_VERSION="${GO_VERSION}" install-test-toolchains
ENV PATH="/usr/local/go/bin:/home/node/go/bin:${PATH}"
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/packages/shared ./packages/shared
COPY --chown=node:node --from=build /app/packages/data ./packages/data
COPY --chown=node:node --from=build /app/packages/runtime ./packages/runtime
COPY --chown=node:node --from=build /app/packages/api ./packages/api
COPY --chown=node:node --from=build /app/packages/agent ./packages/agent
COPY --chown=node:node --from=build /app/packages/mcp ./packages/mcp
COPY --chown=node:node package.json .
COPY --chown=node:node .docker/docker-entrypoint.sh /usr/local/bin/
# /home/node/.npm is created ROOT-owned by the `npm i -g` above (that RUN executes as root
# while HOME=/home/node). The agent process runs as `node` (uid 1000), so every later npx
# invocation fails with EACCES on /home/node/.npm/_cacache/tmp — which is how a consumer's
# commit-time gates break: `npx markdownlint-cli2` cannot spawn, pre-commit still reports
# "markdownlint violations", and the rejection reason is npm cache permissions rather than
# any real lint finding. Observed live 2026-07-23 by a parity audit run inside this image.
RUN install -d -o node -g node /app /data /home/www \
    && chown -R node:node /home/node/.npm
# Симлинки на claude-auth volume — без них на read_only rootfs падают:
#   - .gitconfig — `gh auth setup-git` не может lock'нуть файл
#   - .claude.json — общий config Claude CLI, без которого MCP install падает (EROFS)
# Цели симлинков лежат на writable volume, создаются при первой записи.
RUN ln -sf /home/node/.claude/.gitconfig /home/node/.gitconfig \
    && ln -sf /home/node/.claude/claude.json /home/node/.claude.json \
    && chown -h node:node /home/node/.gitconfig /home/node/.claude.json
EXPOSE 3009 3010 3100
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npx", "tsx", "packages/api/src/index.ts"]

# ---- Web (Angie reverse proxy + static) ----
FROM docker.angie.software/angie:1.11.4-alpine AS web
# Proxy (optional) — separate ARGs because this stage does NOT inherit from `base`.
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG ALL_PROXY
ARG NO_PROXY
ENV HTTP_PROXY=${HTTP_PROXY} \
    HTTPS_PROXY=${HTTPS_PROXY} \
    ALL_PROXY=${ALL_PROXY} \
    NO_PROXY=${NO_PROXY} \
    http_proxy=${HTTP_PROXY} \
    https_proxy=${HTTPS_PROXY} \
    all_proxy=${ALL_PROXY} \
    no_proxy=${NO_PROXY}
RUN apk add --no-cache gettext
COPY --from=build /app/packages/web/dist /usr/share/angie/html
COPY .docker/angie.conf /etc/angie/http.d/default.conf
COPY .docker/angie.production.conf /etc/angie/http.d/production.conf.template
EXPOSE 80 443

# Legacy targets `api` / `agent` / `mcp` collapsed into `app` above — keep aliases
# so existing dev compose (`target: api|agent|mcp`) keeps working until callers
# migrate to `target: app` with per-service `command:` in compose.
FROM app AS api
CMD ["npx", "tsx", "packages/api/src/index.ts"]

FROM app AS agent
CMD ["npx", "tsx", "packages/agent/src/index.ts"]

FROM app AS mcp
CMD ["npx", "tsx", "packages/mcp/src/index.ts"]
