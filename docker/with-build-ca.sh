#!/bin/sh
# Run a build command trusting the optional extra CA (see BUILD_CA_FILE in docker/Dockerfile).
if [ -s /usr/local/share/build-extra-ca.pem ]; then
  export NODE_EXTRA_CA_CERTS=/usr/local/share/build-extra-ca.pem
fi
exec "$@"
