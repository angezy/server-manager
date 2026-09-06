FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig.base.json ./
COPY host-agent host-agent
COPY shared shared
RUN npm ci && npm run build:agent
FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/host-agent ./dist/host-agent
USER node
CMD ["node", "dist/host-agent/src/server.js"]
