# Brio's service images, one Dockerfile with a target per service:
#   docker build --target api    -t brio-api .
#   docker build --target runner -t brio-runner .
#   docker build --target web    -t brio-web --build-arg API_URL=http://api:4000 .
# The API and runner run the TypeScript sources with tsx (as in development); the web app is a Next.js production
# build. Sandbox images (apps/runner/images) are built by the runner on first use.

ARG NODE_IMAGE=node:22.22.0-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.11.1 --activate
WORKDIR /app

# Dependencies from the lockfile alone, so this layer is cached until the lockfile changes.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch --frozen-lockfile

FROM deps AS source
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --offline --frozen-lockfile

# ---- API: REST, SSE, MCP and A2A; hosts the orchestrator. Also runs migrations (`pnpm db:migrate`).
FROM source AS api
ENV NODE_ENV=production PORT=4000 HOST=0.0.0.0
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
WORKDIR /app/apps/api
CMD ["node", "--import", "tsx", "src/main.ts"]

# ---- Runner: pulls attempts from the queue and runs each in its own Docker sandbox. It drives the host's Docker
# (the socket is mounted), so it needs the Docker CLI and git, and runs as root inside its container.
FROM source AS runner
ARG TARGETARCH
ARG DOCKER_CLI_VERSION=27.5.1
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && arch="$([ "$TARGETARCH" = "arm64" ] && echo aarch64 || echo x86_64)" \
 && curl -fsSL "https://download.docker.com/linux/static/stable/${arch}/docker-${DOCKER_CLI_VERSION}.tgz" \
    | tar -xz -C /usr/local/bin --strip-components=1 docker/docker \
 && docker --version
ENV NODE_ENV=production BRIO_RUNNER_DIR=/var/lib/brio/runner BRIO_RUNNER_HEALTH_PORT=4100
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD node -e "fetch('http://127.0.0.1:4100/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
WORKDIR /app/apps/runner
CMD ["node", "--import", "tsx", "src/main.ts"]

# ---- Web: the Next.js app. API_URL is where it proxies /api, /v1, /mcp, /a2a and /.well-known (baked in at build).
FROM source AS web-build
ARG API_URL=http://api:4000
ENV API_URL=${API_URL} NODE_ENV=production
RUN pnpm --filter @brio/web build

FROM web-build AS web
ENV PORT=3000 HOSTNAME=0.0.0.0
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"
WORKDIR /app/apps/web
CMD ["node", "node_modules/next/dist/bin/next", "start", "--port", "3000"]
