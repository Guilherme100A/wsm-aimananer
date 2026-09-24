# Build a partir da raiz do monorepo: docker build -f apps/dashboard/Dockerfile .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @wsm/dashboard build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /repo/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 80
