FROM oven/bun:1.4.2 AS build
ARG APP_VERSION=dev
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:latest AS runtime
ARG APP_VERSION=dev
WORKDIR /app
# ssh client for the environment SSH probe (openssh-client, no server)
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends openssh-client && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production APP_VERSION=${APP_VERSION}
COPY --from=build /app/.output ./.output
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json ./package.json
EXPOSE 3000
CMD ["bun", ".output/server/index.mjs"]
