#!/bin/sh
ENTERPRISE_URL="https://aptv.ghe.com/"
if [ "$1" = "--auth" ]; then
  # Run auth command
  exec bun --use-system-ca run dist/main.js auth --enterprise-url="$ENTERPRISE_URL"
else
  # Default command
  exec bun --use-system-ca run dist/main.js start -g "$GH_TOKEN" --enterprise-url="$ENTERPRISE_URL" "$@"
fi

