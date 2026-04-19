FROM node:22-slim AS base

# Install build deps for better-sqlite3 native module.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first for better caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy app source.
COPY src ./src
COPY public ./public

# Data volume for SQLite DB — mount at runtime.
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "src/server.js"]
