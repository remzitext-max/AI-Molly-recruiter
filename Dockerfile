# One image runs both the web app and the background worker.
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npx next build

FROM base AS runtime
ENV NODE_ENV=production
RUN groupadd -r app && useradd -r -g app -d /app app
COPY --from=build /app /app
RUN mkdir -p /data/storage && chown -R app:app /data /app/.next
USER app
ENV STORAGE_DIR=/data/storage
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
