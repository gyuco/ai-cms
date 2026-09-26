# Changeset checks and builds (E11.2). Runs AI-written site code: it holds no platform
# secret (only its own API token) and reaches only the staging network and the egress proxy.
FROM node:22-alpine
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1 PNPM_STORE_DIR=/pnpm-store
COPY docker/images/with-ca.sh /usr/local/bin/with-ca
RUN --mount=type=secret,id=extra_ca,required=false \
  with-ca apk add --no-cache git tar \
  && with-ca npm install -g pnpm@10.33.0
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# Every package of the lockfile, so that runs install offline. Owned by root and read-only
# for the builder user: a run copies packages out of it and cannot alter it for the next one.
RUN --mount=type=secret,id=extra_ca,required=false \
  with-ca pnpm fetch --store-dir /pnpm-store \
  && chmod -R a+rX /pnpm-store
COPY . .
RUN pnpm install --frozen-lockfile --offline --store-dir /pnpm-store --filter @ai-cms/builder...
# Named volumes inherit this ownership on first mount; /work holds the private copy of each run.
RUN adduser -D -u 1002 builder \
  && mkdir -p /data/artifacts /data/workspaces /work \
  && chown builder:builder /data/artifacts /work
ENV PLATFORM_ROOT=/repo BUILDER_WORK_ROOT=/work ARTIFACTS_ROOT=/data/artifacts \
  WORKSPACES_ROOT=/data/workspaces PORT=8090
USER builder
EXPOSE 8090
CMD ["apps/builder/node_modules/.bin/tsx", "apps/builder/src/main.ts"]
