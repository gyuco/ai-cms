# MVP 1, phase A: serves the site template directly.
# From E12 on, the runtime serves release artifacts from the releases volume.
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
RUN pnpm turbo run build --filter=@ai-cms/site-template

FROM node:22-alpine
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/templates/site/.next/standalone ./
COPY --from=build --chown=node:node /repo/templates/site/.next/static ./templates/site/.next/static
USER node
EXPOSE 3000
CMD ["node", "templates/site/server.js"]
