import { afterEach, expect, mock, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  createHandlerLogger,
  debugJson,
  debugJsonAsync,
  debugJsonTail,
  shutdownLoggerRuntime,
} from "~/lib/logger"
import { state } from "~/lib/state"

const LOG_DIR_ENV = "COPILOT_API_LOG_DIR"
const originalLogDir = process.env[LOG_DIR_ENV]

afterEach(() => {
  state.verbose = false
  if (originalLogDir === undefined) {
    Reflect.deleteProperty(process.env, LOG_DIR_ENV)
  } else {
    process.env[LOG_DIR_ENV] = originalLogDir
  }
})

test("debugJson skips serialization when verbose logging is disabled", () => {
  state.verbose = false

  const logger = {
    debug: mock(() => {}),
  }
  const toJSON = mock(() => ({ ok: true }))

  debugJson(logger as never, "payload", { toJSON })

  expect(toJSON).not.toHaveBeenCalled()
  expect(logger.debug).not.toHaveBeenCalled()
})

test("debugJson logs the serialized payload when verbose logging is enabled", () => {
  state.verbose = true

  const logger = {
    debug: mock(() => {}),
  }
  const payload = { ok: true }

  debugJson(logger as never, "payload", payload)

  expect(logger.debug).toHaveBeenCalledWith("payload", JSON.stringify(payload))
})

test("debugJsonAsync skips reading when verbose logging is disabled", async () => {
  state.verbose = false

  const logger = {
    debug: mock(() => {}),
  }
  const readValue = mock(() => Promise.resolve({ body: "request body" }))

  await debugJsonAsync(logger as never, "payload", readValue)

  expect(readValue).not.toHaveBeenCalled()
  expect(logger.debug).not.toHaveBeenCalled()
})

test("debugJsonAsync reads and logs when verbose logging is enabled", async () => {
  state.verbose = true

  const logger = {
    debug: mock(() => {}),
  }
  const payload = { body: "response body" }
  const readValue = mock(() => Promise.resolve(payload))

  await debugJsonAsync(logger as never, "payload", readValue)

  expect(readValue).toHaveBeenCalledTimes(1)
  expect(logger.debug).toHaveBeenCalledWith("payload", JSON.stringify(payload))
})

test("debugJsonTail preserves tail truncation behavior", () => {
  state.verbose = true

  const logger = {
    debug: mock(() => {}),
  }
  const payload = { text: "abcdefghijklmnopqrstuvwxyz" }
  const expected = JSON.stringify(payload).slice(-10)

  debugJsonTail(logger as never, "payload", { value: payload, tailLength: 10 })

  expect(logger.debug).toHaveBeenCalledWith("payload", expected)
})

test("createHandlerLogger writes to COPILOT_API_LOG_DIR when set", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-logs-"))
  process.env[LOG_DIR_ENV] = logDir

  try {
    const logger = createHandlerLogger("env-override-handler")
    for (let index = 0; index < 100; index += 1) {
      logger.error(`line-${index}`)
    }

    const dateKey = new Date().toLocaleDateString("sv-SE")
    const filePath = path.join(logDir, `env-override-handler-${dateKey}.log`)

    // Poll until the last line is flushed to disk: the log file is created
    // asynchronously by fs.createWriteStream, so it can exist while still
    // empty. Checking only for existence would race with the async write.
    let content = ""
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (fs.existsSync(filePath)) {
        content = fs.readFileSync(filePath, "utf8")
        if (content.includes("line-99")) {
          break
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    expect(fs.existsSync(filePath)).toBe(true)
    expect(content).toContain("line-0")
    expect(content).toContain("line-99")
  } finally {
    // Close the write stream before deleting: Windows cannot remove a
    // directory while a file handle is still open. Retries cover the brief
    // window until the stream's fd is released after end().
    shutdownLoggerRuntime()
    fs.rmSync(logDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  }
})
