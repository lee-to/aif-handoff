# ---- Base ----
FROM node:22-slim AS base
WORKDIR /app

# ---- Dependencies ----
FROM base AS deps
COPY package.json package-lock.json turbo.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/data/package.json packages/data/
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
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/* \
    && npm i -g @anthropic-ai/claude-code
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/data ./packages/data
COPY --from=build /app/packages/api ./packages/api
COPY package.json .
COPY .claude .claude
COPY .docker/docker-entrypoint.sh /usr/local/bin/
RUN mkdir -p /data /home/www && chown -R node:node /app /data /home/www
EXPOSE 3009
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npx", "tsx", "packages/api/src/index.ts"]

# ---- Web (Angie reverse proxy + static) ----
FROM docker.angie.software/angie:1.11.4-alpine AS web
RUN apk add --no-cache gettext
COPY --from=build /app/packages/web/dist /usr/share/angie/html
COPY .docker/angie.conf /etc/angie/http.d/default.conf
COPY .docker/angie.production.conf /etc/angie/http.d/production.conf.template
EXPOSE 80 443

# ---- Agent ----
FROM base AS agent
ENV NODE_ENV=production HOME=/home/node
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/* \
    && npm i -g @anthropic-ai/claude-code
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/data ./packages/data
COPY --from=build /app/packages/agent ./packages/agent
COPY package.json .
COPY .claude .claude
COPY .docker/docker-entrypoint.sh /usr/local/bin/
RUN mkdir -p /data /home/www && chown -R node:node /app /data /home/www
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npx", "tsx", "packages/agent/src/index.ts"]

# ---- MCP ----
FROM base AS mcp
ENV NODE_ENV=production HOME=/home/node
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/data ./packages/data
COPY --from=build /app/packages/mcp ./packages/mcp
COPY package.json .
COPY .docker/docker-entrypoint.sh /usr/local/bin/
RUN mkdir -p /data /home/www && chown -R node:node /app /data /home/www
EXPOSE 3100
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npx", "tsx", "packages/mcp/src/index.ts"]
