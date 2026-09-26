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
RUN pnpm turbo run build --filter=@ai-cms/cms-api

FROM node:22-alpine
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3100 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/cms-api/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/cms-api/.next/static ./apps/cms-api/.next/static
USER node
EXPOSE 3100
CMD ["node", "apps/cms-api/server.js"]
