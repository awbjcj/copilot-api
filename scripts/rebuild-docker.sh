#!/usr/bin/env bash
# Build and health-check a replacement; retain the old container for rollback.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTAINER="${1:-copilot-api}"
IMAGE="copilot-api:local"
DATA_MOUNT="copilot-api-data"
PORT_ARGS=(--publish "127.0.0.1:4141:4141")
RUN_ARGS=()
COMMAND=()
BACKUP="${CONTAINER}-backup-$(date +%s)-$$"
CANDIDATE="copilot-api:rebuild-$(date +%s)-$$"
REPLACED=false
STARTING=false
WAS_RUNNING=false
HEALTH_TIMEOUT="${REBUILD_HEALTH_TIMEOUT:-240}"
if ! [[ "$HEALTH_TIMEOUT" =~ ^[1-9][0-9]*$ ]]; then
  echo "error: REBUILD_HEALTH_TIMEOUT must be a positive number of seconds" >&2
  exit 1
fi

# Git Bash must leave Docker's Linux mount paths untouched on Windows.
export MSYS_NO_PATHCONV=1

rollback() {
  local status=$?
  trap - EXIT INT TERM
  if [ "$status" -ne 0 ]; then
    if [ "$STARTING" = true ]; then
      docker container rm --force "$CONTAINER" >/dev/null 2>&1 || true
    fi
    if [ "$REPLACED" = true ]; then
      echo "==> Restoring $CONTAINER from $BACKUP" >&2
      if docker container rename "$BACKUP" "$CONTAINER"; then
        if [ "$WAS_RUNNING" = true ]; then
          docker start "$CONTAINER" || echo "error: restart $CONTAINER manually" >&2
        fi
      else
        echo "error: original container retained as $BACKUP; restore it manually" >&2
      fi
    fi
  fi
  exit "$status"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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
  PREVIOUS_TARGET="$(docker container inspect --format '{{with index .Config.Labels "com.copilot-api.rebuild.image"}}{{.}}{{end}}' "$CONTAINER")"
  IMAGE="${PREVIOUS_TARGET:-$IMAGE}"
  # Digest-only references cannot be retagged; retain them on the backup and
  # publish the replacement under the local build tag.
  if [[ "$IMAGE" == *@* ]] || [[ "$IMAGE" == sha256:* ]]; then
    IMAGE="copilot-api:local"
  fi
  WAS_RUNNING="$(docker container inspect --format '{{.State.Running}}' "$CONTAINER")"
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

fi

echo "==> Building $CANDIDATE from $PROJECT_ROOT without cached layers"
docker build --pull --no-cache --tag "$CANDIDATE" "$PROJECT_ROOT"

if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  docker container rename "$CONTAINER" "$BACKUP"
  REPLACED=true
  docker stop "$BACKUP"
fi
echo "==> Starting $CONTAINER"
STARTING=true
docker run --detach \
  --name "$CONTAINER" \
  --label "com.copilot-api.rebuild.image=$IMAGE" \
  --restart unless-stopped \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m,mode=1777 \
  "${PORT_ARGS[@]}" \
  --volume "$DATA_MOUNT:/data" \
  --env COPILOT_API_HOME=/data \
  "${RUN_ARGS[@]}" \
  "$CANDIDATE" "${COMMAND[@]}"

deadline=$((SECONDS + HEALTH_TIMEOUT))
while true; do
  health="$(docker container inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$CONTAINER")"
  running="$(docker container inspect --format '{{.State.Running}}' "$CONTAINER")"
  if [ "$running" = true ] && [ "$health" = healthy ]; then
    break
  fi
  if [ "$running" != true ] || [ "$health" = unhealthy ] || [ "$health" = missing ] || [ "$SECONDS" -ge "$deadline" ]; then
    echo "error: replacement failed its health check ($health); rolling back" >&2
    exit 1
  fi
  sleep 2
done

docker tag "$CANDIDATE" "$IMAGE"
trap - EXIT INT TERM
echo "==> Healthy replacement running; previous container retained as $BACKUP when present"
docker ps --filter "name=^/${CONTAINER}$" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
