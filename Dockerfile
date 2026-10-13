FROM node:22-alpine
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY scripts ./scripts
COPY config ./config

RUN pnpm install --frozen-lockfile
RUN pnpm build:admin

EXPOSE 5173 8000 9001
CMD ["pnpm", "--filter", "@mcp/gateway", "dev"]
