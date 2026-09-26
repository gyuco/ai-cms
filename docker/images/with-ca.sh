#!/bin/sh
# Runs a command trusting an optional extra CA (BuildKit secret "extra_ca"),
# for builds behind TLS-inspecting proxies. Without the secret it just runs the command.
set -eu
if [ -s /run/secrets/extra_ca ]; then
  cat /etc/ssl/certs/ca-certificates.crt /run/secrets/extra_ca > /tmp/ca-bundle.pem
  export SSL_CERT_FILE=/tmp/ca-bundle.pem
  export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca
  export npm_config_cafile=/tmp/ca-bundle.pem
fi
exec "$@"
