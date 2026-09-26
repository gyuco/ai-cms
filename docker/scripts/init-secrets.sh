#!/bin/sh
# Generates random local secrets once. Existing files are never overwritten.
set -eu
dir="$(cd "$(dirname "$0")/.." && pwd)/secrets"
mkdir -p "$dir"
chmod 700 "$dir"

for name in \
  pg_core_admin pg_core_owner pg_core_api pg_core_worker pg_core_site_ro \
  pg_prod_admin pg_prod_owner pg_prod_app \
  pg_staging_admin pg_staging_owner pg_staging_app \
  s3_access_key s3_secret_key \
  session_secret ai_keys_master revalidate_token
do
  file="$dir/$name"
  if [ ! -s "$file" ]; then
    openssl rand -hex 24 | tr -d '\n' > "$file"
    chmod 644 "$file"  # readable by non-root users inside containers; the directory stays 700
    echo "created secret: $name"
  fi
done
