# Stage 1: Build web frontend
FROM node:22.22.3-alpine3.22 AS web-builder
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Stage 2: Build API server
FROM node:22.22.3-alpine3.22 AS api-builder
WORKDIR /app/api
# Native modules (better-sqlite3, bcrypt) compile from source on Alpine.
RUN apk add --no-cache python3 make g++
COPY api/package*.json ./
RUN npm ci
COPY api/tsconfig.json ./
COPY api/src ./src
RUN npx tsc

# Stage 3: Production runtime
FROM node:22.22.3-alpine3.22
WORKDIR /app

# Copy compiled API + dependencies (native .node binaries built in stage 2)
COPY --from=api-builder /app/api/dist ./dist
COPY --from=api-builder /app/api/node_modules ./node_modules
COPY --from=api-builder /app/api/package.json ./

# Copy frontend build into public/ for @fastify/static
COPY --from=web-builder /app/web/dist ./public

# Writable data dir for the SQLite database (SQLITE_PATH defaults to ./data/app.db)
RUN mkdir -p /app/data

# Run as a non-root user
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

ENV NODE_ENV=production
ENV PORT=3000
ENV SQLITE_PATH=/app/data/app.db
EXPOSE 3000
CMD ["node", "dist/index.js"]
