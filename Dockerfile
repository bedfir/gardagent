# Gardagent gateway image, including the admin console (/console/).
# Only Docker is required on the host machine.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json packages/core/
COPY apps/gateway/package.json apps/gateway/
COPY apps/console/package.json apps/console/
RUN if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else pnpm install; fi
COPY packages packages
COPY apps apps
RUN pnpm -r build && pnpm deploy --filter @gardagent/gateway --prod --legacy /out

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV GARDAGENT_CONSOLE_DIR=/app/console
COPY --from=build /out .
COPY --from=build /app/apps/console/dist ./console
RUN mkdir -p /app/spool && chown node:node /app/spool
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
