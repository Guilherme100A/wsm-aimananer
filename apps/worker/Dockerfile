# Build a partir da raiz do monorepo: docker build -f apps/worker/Dockerfile .
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @wsm/worker... build
RUN pnpm deploy --filter @wsm/worker --prod /out

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 9464 9465
CMD ["node", "dist/main.js"]
