import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// An exported shell function intercepts every docker call: no daemon is touched.
const harness = `
docker() {
  printf '%s ' "$@" >> "$DOCKER_LOG"
  printf '\\n' >> "$DOCKER_LOG"
  case "$1 $2" in
    'container inspect')
      if [ "$3" != --format ]; then
        [ "$SCENARIO" != fresh ]; return
      fi
      case "$4" in
        *com.docker.compose.project*) [ "$SCENARIO" != compose ] || echo project ;;
        *com.copilot-api.rebuild.image*) [ "$SCENARIO" != rebuilt ] || echo custom:stable ;;
        *Config.Image*) echo copilot-api:local ;;
        *State.Running*) [ "$SCENARIO" = stopped ] && echo false || echo true ;;
        *Mounts*) [ "$SCENARIO" = missing-mount ] || echo copilot-api-data ;;
        *PortBindings*) echo '127.0.0.1|4141' ;;
        *Config.Env*) echo 'EXAMPLE=value with spaces' ;;
        *Config.Cmd*) echo start ;;
        *State.Health*)
          case "$SCENARIO" in
            unhealthy) echo unhealthy ;;
            timeout) echo starting ;;
            missing-health) echo missing ;;
            *) echo healthy ;;
          esac ;;
      esac ;;
    'build '*) [ "$SCENARIO" != build-failure ] ;;
    'run '*) [ "$SCENARIO" != start-failure ] ;;
    'tag '*) [ "$SCENARIO" != tag-failure ] ;;
    *) return 0 ;;
  esac
}
export -f docker
source "$REBUILD_SCRIPT" gateway
`

function runScenario(scenario: string) {
  const directory = mkdtempSync(join(tmpdir(), "copilot-rebuild-"))
  const script = join(directory, "harness.sh")
  const log = join(directory, "docker.log")
  writeFileSync(script, harness)
  writeFileSync(log, "")
  try {
    const result = Bun.spawnSync(
      [
        process.platform === "win32" ?
          "C:/Program Files/Git/bin/bash.exe"
        : "bash",
        script,
      ],
      {
        env: {
          ...process.env,
          SCENARIO: scenario,
          DOCKER_LOG: log.replaceAll("\\", "/"),
          REBUILD_SCRIPT: resolve("scripts/rebuild-docker.sh").replaceAll(
            "\\",
            "/",
          ),
          REBUILD_HEALTH_TIMEOUT: "1",
        },
      },
    )
    return {
      code: result.exitCode,
      log: readFileSync(log, "utf8"),
      error: result.stderr.toString(),
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test.each(["build-failure", "compose", "missing-mount"])(
  "%s leaves the original container untouched",
  (scenario) => {
    const result = runScenario(scenario)
    expect(result.code).not.toBe(0)
    expect(result.log).not.toContain("container rename")
    expect(result.log).not.toContain("container rm")
    expect(result.log).not.toContain("image rm")
    expect(result.log).not.toContain("stop gateway")
  },
)

test.each([
  "start-failure",
  "unhealthy",
  "missing-health",
  "timeout",
  "tag-failure",
])("%s restores the original container", (scenario) => {
  const result = runScenario(scenario)
  expect(result.code).not.toBe(0)
  expect(result.log.indexOf("build --pull")).toBeLessThan(
    result.log.indexOf("stop gateway-backup"),
  )
  expect(result.log).toContain("container rm --force gateway")
  expect(result.log).toMatch(/container rename gateway-backup-\S+ gateway/)
  expect(result.log).toContain("start gateway")
  expect(result.log).not.toContain("image rm")
})

test.each(["healthy", "fresh", "rebuilt"])(
  "%s promotes only a healthy image and keeps rollback state",
  (scenario) => {
    const result = runScenario(scenario)
    expect(result.code).toBe(0)
    expect(result.log).toContain("tag copilot-api:rebuild-")
    expect(result.log.indexOf("State.Health")).toBeLessThan(
      result.log.indexOf("\ntag copilot-api"),
    )
    expect(result.log).not.toContain("container rm")
    expect(result.log).not.toContain("image rm")
    if (scenario === "rebuilt") {
      expect(result.log).toContain(
        "--label com.copilot-api.rebuild.image=custom:stable",
      )
      expect(result.log).toMatch(/\ntag copilot-api:rebuild-\S+ custom:stable/)
    }
    if (scenario === "healthy")
      expect(result.log).toContain("--env EXAMPLE=value with spaces")
  },
)
