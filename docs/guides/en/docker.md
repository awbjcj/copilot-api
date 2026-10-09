# Docker

[Home](../../../README.md) · [Documentation](README.md) · [简体中文](../zh-CN/docker.md)

## Using with Docker

The supplied Compose file uses the current published `ghcr.io/caozhiyuan/copilot-api:latest` image. No local image build is required. It stores gateway state in `/data` and runs the server as the non-root `bun` user.

### Quick start with Docker Compose

Run these commands from the repository root. Replace `YOUR_GATEWAY_API_KEY` with a strong key for clients connecting to this gateway:

```sh
mkdir -p copilot-data
docker compose pull
docker compose run --rm copilot-api --auth keys --add YOUR_GATEWAY_API_KEY
docker compose run --rm copilot-api --auth login
docker compose up -d
docker compose ps
```

If `COPILOT_API_GITHUB_TOKEN` or the legacy `GH_TOKEN` is already available in your environment or a private `.env` file, you can skip `--auth login`. A GitHub token authorizes access to GitHub Copilot; it does not replace the gateway API key configured above.

Before every server or authentication run, the one-shot `data-init` service repairs ownership of the gateway's own state in the mounted data directory: `config.json`, `github_token` (including the enterprise `ent_github_token` and OAuth app subdirectories such as `opencode/github_token`), `codex_credentials.json`, `desktop-config.json`, `copilot-api.sqlite*`, `logs/`, and `cache/`. Other files and directories in the mount are left untouched. This lets the non-root server reuse files written by an earlier root container, including mode `0600` configuration files. The host directory defaults to `./copilot-data`, matching the earlier Docker instructions; Compose mounts it at `/data` and sets `COPILOT_API_HOME` accordingly. Set `COPILOT_API_DATA_DIR` in the environment or your own `.env` to use an existing directory elsewhere.

```dotenv
COPILOT_API_DATA_DIR=/absolute/path/to/copilot-data
```

Create the host directory before the first run. Compose does not auto-create a missing host directory (`create_host_path: false`), so a typo in `COPILOT_API_DATA_DIR` fails fast instead of starting with empty state. The one-shot `data-init` service also refuses unsafe values such as `/`, and refuses to run when the mount contains system directories (`/etc`, `/usr`, and so on), which means the path resolved to a system root.

The local endpoint is `http://127.0.0.1:4141`. To publish the gateway on every host interface after configuring a gateway API key, add this to your `.env`:

```dotenv
COPILOT_API_BIND=0.0.0.0
COPILOT_API_PORT=4141
```

The Compose service also forwards `COPILOT_API_SQLITE_DB_PATH`, `COPILOT_API_ENTERPRISE_URL`, and `COPILOT_API_OAUTH_APP` from the environment or a private `.env` file. SQLite paths are container paths and should stay under the writable `/data` mount, for example:

```dotenv
COPILOT_API_SQLITE_DB_PATH=/data/copilot-api.sqlite
COPILOT_API_ENTERPRISE_URL=company.ghe.com
COPILOT_API_OAUTH_APP=opencode
```

Token and proxy variables can be overridden in the same file. Proxy addresses must be reachable from inside the container. Keep the internal port at `4141` so the health check remains valid.

### Rebuild a standalone container from local files

For a gateway started with `docker run`, run this from the repository root:

```sh
make docker-rebuild COPILOT_CONTAINER=copilot-api
```

The target builds under a fresh image tag with `--pull --no-cache` while the old
container keeps running. After the build succeeds, it retains the original
container under a backup name, stops it, and starts the candidate using the same
`/data` mount, published ports, environment, and startup arguments. Other new
container settings use the defaults in `scripts/rebuild-docker.sh`.

The candidate must pass the Dockerfile health check within 240 seconds
(`REBUILD_HEALTH_TIMEOUT` can override this). Startup or health failure removes
only the candidate container, restores the original name, and restarts the old
container if it was previously running. Build failure leaves the old service and
image untouched. Success promotes the image tag and retains the stopped backup
container and its image for manual rollback/cleanup. This is process rollback;
both versions share `/data`, so it does not undo data migrations.


Choose the exact existing container name. Compose-managed containers are rejected. If the name does not exist, the target creates `copilot-api:local` with the `copilot-api-data` volume and loopback port `4141`. Run it from the companion backend with `make rebuild-copilot-api COPILOT_CONTAINER=<name>`.
