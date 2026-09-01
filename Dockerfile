# syntax=docker/dockerfile:1.7

ARG BUN_VERSION=1.3.14

FROM oven/bun:${BUN_VERSION}-slim AS root-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:${BUN_VERSION}-slim AS gui-deps
WORKDIR /app/gui
COPY gui/package.json gui/bun.lock ./
RUN bun install --frozen-lockfile

FROM root-deps AS build
WORKDIR /app
COPY --from=gui-deps /app/gui/node_modules ./gui/node_modules
COPY . .
RUN bun run typecheck \
 && cd gui && bun run build \
 && cd .. && bun run prepare:package

FROM oven/bun:${BUN_VERSION}-slim AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile \
 && rm -rf /root/.bun/install/cache /tmp/*

FROM oven/bun:${BUN_VERSION}-slim AS runtime
ARG VCS_REF=unknown
ARG VERSION=dev
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="OpenCodex" \
      org.opencontainers.image.description="Universal provider proxy for OpenAI Codex and Claude Code" \
      org.opencontainers.image.source="https://github.com/GroepOnline/opencodex" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /var/lib/opencodex /app/scripts \
 && chown -R bun:bun /var/lib/opencodex /app

WORKDIR /app
COPY --from=prod-deps --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/package.json /app/bun.lock ./
COPY --from=build --chown=bun:bun /app/bin ./bin
COPY --from=build --chown=bun:bun /app/src ./src
COPY --from=build --chown=bun:bun /app/gui/dist ./gui/dist
COPY --from=build --chown=bun:bun /app/assets ./assets
COPY --from=build --chown=bun:bun /app/scripts/container-health.ts ./scripts/container-health.ts
COPY --from=build --chown=bun:bun --chmod=0555 /app/scripts/container-entrypoint.sh ./scripts/container-entrypoint.sh

ENV NODE_ENV=production \
    OPENCODEX_HOME=/var/lib/opencodex \
    OPENCODEX_BIND_HOST=0.0.0.0 \
    OPENCODEX_HEALTH_HOST=127.0.0.1 \
    OPENCODEX_HEALTH_PORT=10100 \
    OPENCODEX_GIT_SHA=${VCS_REF}

USER bun
VOLUME ["/var/lib/opencodex"]
EXPOSE 10100
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD ["bun", "run", "scripts/container-health.ts"]

ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/container-entrypoint.sh"]
CMD ["bun", "run", "src/cli/index.ts", "start", "--port", "10100"]
