FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig.base.json vitest.config.ts ./
COPY backend backend
COPY host-agent host-agent
COPY frontend frontend
COPY shared shared
COPY migrations migrations
RUN npm ci && npm run build:backend
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/backend ./dist/backend
COPY migrations ./migrations
USER node
EXPOSE 3010
CMD ["node", "dist/backend/src/server.js"]
