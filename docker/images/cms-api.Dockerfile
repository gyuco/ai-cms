FROM node:22-alpine AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY docker/images/with-ca.sh /usr/local/bin/with-ca
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=secret,id=extra_ca,required=false with-ca pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline
ENV NEXT_TELEMETRY_DISABLED=1
# Builds @ai-cms/widget first (workspace dependency), then cms-api.
RUN pnpm turbo run build --filter=@ai-cms/cms-api
# Native module needed by the admin CLI outside the Next.js bundle.
RUN mkdir -p /out/node_modules && cp -rL node_modules/.pnpm/node_modules/@node-rs /out/node_modules/

FROM node:22-alpine
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3100 HOSTNAME=0.0.0.0 \
  MIGRATIONS_DIR=/app/migrations WIDGET_BUNDLE=/app/widget/widget.js
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/cms-api/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/cms-api/.next/static ./apps/cms-api/.next/static
COPY --from=build --chown=node:node /repo/packages/db/migrations ./migrations
COPY --from=build --chown=node:node /repo/packages/widget/dist/widget.js ./widget/widget.js
COPY --from=build --chown=node:node /repo/apps/cms-api/dist/admin.mjs ./apps/cms-api/admin.mjs
COPY --from=build --chown=node:node /out/node_modules ./apps/cms-api/node_modules
USER node
EXPOSE 3100
CMD ["node", "apps/cms-api/server.js"]
