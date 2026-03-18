FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/providers/package.json packages/providers/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && curl -fsSL https://asccli.sh/install | bash

ENV PATH="/root/.local/bin:${PATH}"

COPY --from=build /app /app

CMD ["pnpm", "--filter", "@store-agent/worker", "start"]
