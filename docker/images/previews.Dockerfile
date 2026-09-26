# Changeset previews (E10.9): one `next start` per changeset, routed by host name. It runs
# AI-written site code and holds no platform secret; artifacts are mounted read-only.
FROM node:22-alpine
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY docker/images/with-ca.sh /usr/local/bin/with-ca
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=secret,id=extra_ca,required=false with-ca pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline --filter @ai-cms/previews...
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080 \
  ARTIFACTS_ROOT=/data/artifacts PREVIEWS_RUN_ROOT=/previews
# Named volumes inherit this ownership on first mount; /previews holds the running copies.
RUN adduser -D -u 1003 previews \
  && mkdir -p /data/artifacts /previews \
  && chown previews:previews /previews
USER previews
EXPOSE 8080
CMD ["apps/previews/node_modules/.bin/tsx", "apps/previews/src/main.ts"]
