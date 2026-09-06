FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig.base.json ./
COPY frontend frontend
COPY shared shared
RUN npm ci && npm run build:frontend
FROM nginx:1.27-alpine
COPY --from=build /app/dist/frontend /usr/share/nginx/html
COPY nginx/frontend.conf /etc/nginx/conf.d/default.conf
