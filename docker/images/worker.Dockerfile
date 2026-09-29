FROM node:22-alpine
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY docker/images/with-ca.sh /usr/local/bin/with-ca
RUN --mount=type=secret,id=extra_ca,required=false \
  with-ca apk add --no-cache git postgresql17-client \
  && corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=secret,id=extra_ca,required=false with-ca pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline --filter @ai-cms/worker...
ENV NODE_ENV=production
# Named volumes inherit this ownership on first mount.
RUN mkdir -p /data/git /data/workspaces /data/releases /data/backups \
  && chown -R node:node /data \
  # The builder writes the release artifacts here too.
  && chmod 1777 /data/releases
USER node
CMD ["pnpm", "--filter", "@ai-cms/worker", "start"]
