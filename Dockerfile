# Multi-stage Dockerfile for Huddle60
FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Minimal Production Image
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV HUDDLE60_CONFIG_DIR=/app/data

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/templates ./templates
COPY --from=builder /app/ui ./ui

VOLUME ["/app/data"]

EXPOSE 4317

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["ui", "--host", "0.0.0.0", "--port", "4317", "--no-open"]

