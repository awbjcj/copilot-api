#!/bin/sh
ENTERPRISE_URL="https://aptv.ghe.com/"
if [ "$1" = "--auth" ]; then
  # Run auth command
  shift
  exec bun --use-system-ca run dist/main.js auth --enterprise-url="$ENTERPRISE_URL" "$@"
else
  # Default command
  export HOST="${HOST:-0.0.0.0}"
  # Keep the token out of the process list; the server reads it from the env.
  export COPILOT_API_GITHUB_TOKEN="${COPILOT_API_GITHUB_TOKEN:-$GH_TOKEN}"
  exec bun --use-system-ca run dist/main.js start --enterprise-url="$ENTERPRISE_URL" "$@"
fi
