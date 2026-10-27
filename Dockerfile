FROM oven/bun:1.4.4-alpine AS build
ARG APP_VERSION=dev
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.4.4-alpine AS runtime
ARG APP_VERSION=dev
WORKDIR /app
# ssh client for the environment SSH probe (openssh-client, no server)
RUN apk add --no-cache openssh-client
ENV NODE_ENV=production APP_VERSION=${APP_VERSION} HOME=/home/bun
COPY --from=build /app/.output ./.output
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json ./package.json
# non-root runtime: the app reads .output/ + drizzle/ and writes only to the
# data root (attachments; TANDEM_ATTACHMENTS_DIR defaults to /tandem) and
# os.tmpdir() (ssh probe key material — fallback unaffected). /tandem must
# exist and be owned by `bun` BEFORE dropping privileges, or the first
# attachment write dies with EACCES against a root-owned volume path.
RUN mkdir -p /tandem && chown bun:bun /tandem
USER bun
EXPOSE 3000
CMD ["bun", "start"]
