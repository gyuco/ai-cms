FROM node:22-alpine
ARG CLAUDE_CODE_VERSION=2.1.283
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY docker/images/with-ca.sh /usr/local/bin/with-ca
# Claude Code on Alpine needs libgcc, libstdc++ and the system ripgrep.
RUN --mount=type=secret,id=extra_ca,required=false \
  with-ca apk add --no-cache git bash libgcc libstdc++ ripgrep \
  && corepack enable \
  && with-ca npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"
ENV USE_BUILTIN_RIPGREP=0
# Links a user's own subscription: `cms-connect claude-code --user <username>` (TECHNICAL §7.4).
COPY --chmod=755 docker/images/cms-connect /usr/local/bin/cms-connect

# The runner service, from the monorepo like the worker.
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=secret,id=extra_ca,required=false with-ca pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline --filter @ai-cms/agent-runner... \
  && pnpm --filter @ai-cms/agent-runner build
ENV NODE_ENV=production PORT=8070 CMS_API_URL=http://cms-api:3100 \
  WORKSPACES_ROOT=/data/workspaces CLI_AUTH_ROOT=/cli-auth \
  HOOK_SCRIPT=/repo/apps/agent-runner/dist/pre-tool-use.mjs
# Same uid as the worker, which creates the changeset clones in the shared volume.
# Named volumes inherit this ownership on first mount.
RUN mkdir -p /data/workspaces /cli-auth && chown node:node /data/workspaces /cli-auth
USER node
WORKDIR /repo/apps/agent-runner
EXPOSE 8070
# Started without pnpm/corepack: nothing to download at runtime.
CMD ["node_modules/.bin/tsx", "src/main.ts"]
