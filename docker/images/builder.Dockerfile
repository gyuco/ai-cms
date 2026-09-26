# Disposable container for changeset checks and builds (E11.2).
FROM node:22-alpine
COPY docker/images/with-ca.sh /usr/local/bin/with-ca
RUN --mount=type=secret,id=extra_ca,required=false \
  with-ca apk add --no-cache git \
  && corepack enable
RUN adduser -D -u 1002 builder
USER builder
WORKDIR /work
