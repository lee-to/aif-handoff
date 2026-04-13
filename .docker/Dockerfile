# ---- Base ----
FROM node:22-slim AS base
WORKDIR /app
# Proxy (optional) — propagated to all downstream stages via ENV,
# so apt-get / npm / npx all pick it up during build.
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ENV HTTP_PROXY=${HTTP_PROXY} \
    HTTPS_PROXY=${HTTPS_PROXY} \
    NO_PROXY=${NO_PROXY} \
    http_proxy=${HTTP_PROXY} \
    https_proxy=${HTTPS_PROXY} \
    no_proxy=${NO_PROXY}

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
RUN npm ci --ignore-scripts && npm rebuild

# ---- Build ----
FROM deps AS build
COPY . .
RUN npx turbo build

# ---- API ----
FROM base AS api
ENV NODE_ENV=production HOME=/home/node
RUN apt-get update && apt-get install -y --no-install-recommends gosu git && rm -rf /var/lib/apt/lists/* \
    && npm i -g @anthropic-ai/claude-code @openai/codex
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/packages/shared ./packages/shared
COPY --chown=node:node --from=build /app/packages/data ./packages/data
COPY --chown=node:node --from=build /app/packages/runtime ./packages/runtime
COPY --chown=node:node --from=build /app/packages/api ./packages/api
COPY --chown=node:node package.json .
COPY --chown=node:node .docker/docker-entrypoint.sh /usr/local/bin/
RUN install -d -o node -g node /app /data /home/www
EXPOSE 3009
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npx", "tsx", "packages/api/src/index.ts"]

# ---- Web (Angie reverse proxy + static) ----
FROM docker.angie.software/angie:1.11.4-alpine AS web
# Proxy (optional) — separate ARGs because this stage does NOT inherit from `base`.
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ENV HTTP_PROXY=${HTTP_PROXY} \
    HTTPS_PROXY=${HTTPS_PROXY} \
    NO_PROXY=${NO_PROXY} \
    http_proxy=${HTTP_PROXY} \
    https_proxy=${HTTPS_PROXY} \
    no_proxy=${NO_PROXY}
RUN apk add --no-cache gettext
COPY --from=build /app/packages/web/dist /usr/share/angie/html
COPY .docker/angie.conf /etc/angie/http.d/default.conf
COPY .docker/angie.production.conf /etc/angie/http.d/production.conf.template
EXPOSE 80 443

# ---- Agent ----
FROM base AS agent
ENV NODE_ENV=production HOME=/home/node
RUN apt-get update && apt-get install -y --no-install-recommends gosu git && rm -rf /var/lib/apt/lists/* \
    && npm i -g @anthropic-ai/claude-code @openai/codex
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/packages/shared ./packages/shared
COPY --chown=node:node --from=build /app/packages/data ./packages/data
COPY --chown=node:node --from=build /app/packages/runtime ./packages/runtime
COPY --chown=node:node --from=build /app/packages/agent ./packages/agent
COPY --chown=node:node package.json .
COPY --chown=node:node .docker/docker-entrypoint.sh /usr/local/bin/
RUN install -d -o node -g node /app /data /home/www
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npx", "tsx", "packages/agent/src/index.ts"]

# ---- MCP ----
FROM base AS mcp
ENV NODE_ENV=production HOME=/home/node
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/packages/shared ./packages/shared
COPY --chown=node:node --from=build /app/packages/data ./packages/data
COPY --chown=node:node --from=build /app/packages/runtime ./packages/runtime
COPY --chown=node:node --from=build /app/packages/mcp ./packages/mcp
COPY --chown=node:node package.json .
COPY --chown=node:node .docker/docker-entrypoint.sh /usr/local/bin/
RUN install -d -o node -g node /app /data /home/www
EXPOSE 3100
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npx", "tsx", "packages/mcp/src/index.ts"]
