# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# --- Install all workspace deps (cached by lockfile) ---
FROM base AS deps
COPY package.json pnpm-workspace.yaml ./
COPY server/package.json server/
COPY web/package.json web/
COPY pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

# --- Build web SPA ---
FROM deps AS build-web
COPY web/ web/
RUN pnpm --filter @hlm/web build

# --- Build server ---
FROM deps AS build-server
COPY server/ server/
RUN pnpm --filter @hlm/server build

# --- Runtime ---
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build-server /app/server/dist ./server/dist
COPY --from=build-server /app/server/package.json ./server/package.json
COPY --from=build-server /app/server/prisma ./server/prisma
COPY --from=build-server /app/node_modules ./node_modules
COPY --from=build-server /app/server/node_modules ./server/node_modules
COPY --from=build-web /app/web/dist ./web/dist

EXPOSE 3000
# Apply migrations, then start. Server also serves the built SPA (M1 feature).
CMD ["sh", "-c", "cd server && npx prisma migrate deploy && node dist/index.js"]
