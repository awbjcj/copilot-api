#!/usr/bin/env bash
# Replace a standalone gateway container/image while retaining its runtime state.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTAINER="${1:-copilot-api}"
IMAGE="copilot-api:local"
DATA_MOUNT="copilot-api-data"
PORT_ARGS=(--publish "127.0.0.1:4141:4141")
RUN_ARGS=()
COMMAND=()

docker info --format '{{.ServerVersion}}' >/dev/null
if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  if [ -n "$(docker container inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$CONTAINER")" ]; then
    SERVICE="$(docker container inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$CONTAINER")"
    echo "==> $CONTAINER is managed by Compose; rebuilding service $SERVICE locally from $PROJECT_ROOT"
    cd "$PROJECT_ROOT"
    docker compose build --pull --no-cache "$SERVICE"
    docker compose up -d --force-recreate "$SERVICE"
    docker ps --filter "name=^/${CONTAINER}$" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    exit 0
  fi

  IMAGE="$(docker container inspect --format '{{.Config.Image}}' "$CONTAINER")"
  DATA_MOUNT="$(docker container inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{if eq .Type "volume"}}{{.Name}}{{else if eq .Type "bind"}}{{.Source}}{{end}}{{end}}{{end}}' "$CONTAINER")"
  if [ -z "$DATA_MOUNT" ]; then
    echo "error: $CONTAINER has no persistent /data mount; save its state before replacing it" >&2
    exit 1
  fi
  PORT_BINDINGS="$(docker container inspect --format '{{range (index .HostConfig.PortBindings "4141/tcp")}}{{.HostIp}}|{{.HostPort}}{{println}}{{end}}' "$CONTAINER")"
  PORT_ARGS=()
  while IFS='|' read -r host_ip host_port; do
    [ -n "$host_port" ] || continue
    if [[ "$host_ip" == *:* ]]; then
      host_ip="[$host_ip]"
    fi
    PORT_ARGS+=(--publish "${host_ip:+$host_ip:}$host_port:4141")
  done <<< "$PORT_BINDINGS"
  if [ "${#PORT_ARGS[@]}" -eq 0 ]; then
    echo "error: $CONTAINER does not publish port 4141; configure the gateway port before replacing it" >&2
    exit 1
  fi
  ENVIRONMENT="$(docker container inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER")"
  STARTUP_COMMAND="$(docker container inspect --format '{{range .Config.Cmd}}{{println .}}{{end}}' "$CONTAINER")"
  while IFS= read -r value; do
    [ -z "$value" ] || RUN_ARGS+=(--env "$value")
  done <<< "$ENVIRONMENT"
  while IFS= read -r value; do
    [ -z "$value" ] || COMMAND+=("$value")
  done <<< "$STARTUP_COMMAND"

  echo "==> Removing container $CONTAINER (preserving /data)"
  docker container rm --force "$CONTAINER"
fi

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  # Other containers (e.g. Compose) may still reference the old image; retagging replaces it.
  echo "==> Removing image $IMAGE (skipped if in use; the build retags it)"
  docker image rm "$IMAGE" >/dev/null 2>&1 || true
fi

echo "==> Building $IMAGE from $PROJECT_ROOT without cached layers"
docker build --pull --no-cache --tag "$IMAGE" "$PROJECT_ROOT"

# Git Bash must leave Docker's Linux mount paths untouched on Windows.
export MSYS_NO_PATHCONV=1
echo "==> Starting $CONTAINER"
docker run --detach \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m,mode=1777 \
  "${PORT_ARGS[@]}" \
  --volume "$DATA_MOUNT:/data" \
  --env COPILOT_API_HOME=/data \
  "${RUN_ARGS[@]}" \
  "$IMAGE" "${COMMAND[@]}"
docker ps --filter "name=^/${CONTAINER}$" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
