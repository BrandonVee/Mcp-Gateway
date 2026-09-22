FROM node:22-alpine
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY scripts ./scripts

RUN pnpm install --no-frozen-lockfile

EXPOSE 8000 9001 3001 3002
CMD ["pnpm", "--filter", "@mcp/gateway", "dev"]
