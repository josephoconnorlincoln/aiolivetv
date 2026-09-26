FROM node:24-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS builder

WORKDIR /build

# Copy LICENSE file.
COPY LICENSE ./

# Copy the relevant package.json and package-lock.json files.
COPY package*.json ./
COPY packages/server/package*.json ./packages/server/
COPY packages/core/package*.json ./packages/core/
COPY packages/frontend/package*.json ./packages/frontend/
COPY pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY pnpm-lock.yaml ./pnpm-lock.yaml
COPY patches ./patches

# Install dependencies.
RUN pnpm install --frozen-lockfile

# Copy source files.
COPY tsconfig.*json ./

COPY packages/server ./packages/server
COPY packages/core ./packages/core
COPY packages/frontend ./packages/frontend
COPY scripts ./scripts
COPY resources ./resources


# Build the project.
RUN pnpm run build

# Remove development dependencies.
RUN rm -rf node_modules
RUN rm -rf packages/core/node_modules
RUN rm -rf packages/server/node_modules
RUN rm -rf packages/frontend/node_modules

RUN pnpm install --prod --frozen-lockfile


FROM builder AS runtime
WORKDIR /runtime

# Copy the built files from the builder.
# The package.json files must be copied as well for NPM workspace symlinks between local packages to work.
COPY --from=builder /build/package*.json /build/LICENSE ./
COPY --from=builder /build/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /build/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=builder /build/patches ./patches

COPY --from=builder /build/packages/core/package.*json ./packages/core/
COPY --from=builder /build/packages/server/package.*json ./packages/server/

COPY --from=builder /build/packages/core/dist ./packages/core/dist
COPY --from=builder /build/packages/frontend/dist ./packages/frontend/dist
COPY --from=builder /build/packages/server/dist ./packages/server/dist
COPY --from=builder /build/packages/server/src/static ./packages/server/dist/static

COPY --from=builder /build/resources ./resources
COPY --from=builder /build/scripts ./scripts

COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/packages/core/node_modules ./packages/core/node_modules
COPY --from=builder /build/packages/server/node_modules ./packages/server/node_modules

# SQLite lives here. Keep it writable for the distroless image user.
RUN mkdir -p /runtime/data && chmod 777 /runtime/data

FROM gcr.io/distroless/nodejs24-debian12 AS production

LABEL org.opencontainers.image.title="AIOLiveTV"
LABEL org.opencontainers.image.source="https://github.com/mrcanelas/aiolivetv"
LABEL org.opencontainers.image.description="AIOLiveTV combines live TV metadata and stream sources into one configurable Stremio addon."
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"

WORKDIR /app

COPY --from=busybox:1.36.0-uclibc /bin/wget /bin/wget
COPY --from=busybox:1.36.0-uclibc /bin/sh /bin/sh
COPY --from=runtime /runtime /app

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/scripts/healthcheck.js"]
EXPOSE ${PORT:-3000}

# Distroless sets ENTRYPOINT to node. Beamup replaces CMD with /start, which
# becomes `node /start` and crashes. Keep the server in ENTRYPOINT so that
# extra argument is ignored.
ENTRYPOINT ["/nodejs/bin/node", "/app/packages/server/dist/server.js"]
CMD []