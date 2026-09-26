#!/bin/sh
# Builds the SeaweedFS S3 identity file from Docker secrets, then starts the server.
set -eu
cat > /tmp/s3.json <<JSON
{
  "identities": [
    {
      "name": "cms",
      "credentials": [
        {
          "accessKey": "$(cat /run/secrets/s3_access_key)",
          "secretKey": "$(cat /run/secrets/s3_secret_key)"
        }
      ],
      "actions": ["Admin", "Read", "Write", "List", "Tagging"]
    }
  ]
}
JSON
exec weed server -dir=/data -ip.bind=0.0.0.0 -volume.max=0 -master.volumeSizeLimitMB=256 \
  -s3 -s3.port=8333 -s3.config=/tmp/s3.json
