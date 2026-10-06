import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))

test.each([
  ["messages-handler", "provider-messages-web-search"],
  ["provider-messages-web-search", "messages-handler"],
])("Gemini tests remain isolated after %s then %s", (first, second) => {
  const directory = mkdtempSync(join(tmpdir(), "copilot-gemini-isolation-"))
  try {
    // Separate wrappers retain each suite's hook scope and force discovery order.
    const suites = [first, second, "gemini-upgrade", "gemini-handler"]
    const wrappers = suites.map((suite, index) => {
      const wrapper = join(directory, `${index}-${suite}.test.ts`)
      const source = pathToFileURL(join(repoRoot, "tests", `${suite}.test.ts`))
      writeFileSync(wrapper, `await import(${JSON.stringify(source.href)})\n`)
      return wrapper
    })
    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", ...wrappers],
      cwd: repoRoot,
      env: { ...process.env, COPILOT_API_HOME: join(directory, "home") },
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = Buffer.concat([result.stdout, result.stderr]).toString()
    if (result.exitCode !== 0) throw new Error(output)

    let previous = -1
    for (const [index, suite] of suites.entries()) {
      const position = output.indexOf(`${index}-${suite}.test.ts:`)
      expect(position).toBeGreaterThan(previous)
      previous = position
    }
    expect(output).toContain(
      "SDK tool aliases preserve JSON Schema property names",
    )
    expect(output).toContain("Gemini streams text with null OpenAI usage")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
