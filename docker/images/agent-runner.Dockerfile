FROM node:22-alpine
ARG CLAUDE_CODE_VERSION=2.1.283
COPY docker/images/with-ca.sh /usr/local/bin/with-ca
# Claude Code on Alpine needs libgcc, libstdc++ and the system ripgrep.
RUN --mount=type=secret,id=extra_ca,required=false \
  with-ca apk add --no-cache git bash libgcc libstdc++ ripgrep \
  && corepack enable \
  && with-ca npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"
ENV USE_BUILTIN_RIPGREP=0
RUN adduser -D -u 1001 agent \
  && mkdir -p /workspaces /cli-auth \
  && chown agent:agent /workspaces /cli-auth
USER agent
WORKDIR /workspaces
# The runner service is implemented in E8.8 / E10.6; until then the container stays idle.
CMD ["sleep", "infinity"]
