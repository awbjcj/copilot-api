import { createFallbackModel } from "~/lib/provider-model"
import { afterEach, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import { state } from "~/lib/state"
import { closeUsageStore } from "~/lib/token-usage"
import { handleGenerateContent } from "~/routes/gemini/handler"

const originalModels = state.models
const originalFetch = globalThis.fetch
const originalCopilotToken = state.copilotToken
const originalDbPath = process.env.COPILOT_API_SQLITE_DB_PATH

afterEach(async () => {
  state.models = originalModels
  globalThis.fetch = originalFetch
  state.copilotToken = originalCopilotToken
  await closeUsageStore()
  if (originalDbPath === undefined) {
    delete process.env.COPILOT_API_SQLITE_DB_PATH
  } else {
    process.env.COPILOT_API_SQLITE_DB_PATH = originalDbPath
  }
})

test("Gemini streams text with null OpenAI usage and Copilot usage metadata", async () => {
  await closeUsageStore()
  process.env.COPILOT_API_SQLITE_DB_PATH = ":memory:"
  state.models = { object: "list", data: [createFallbackModel("gemini-test")] }
  state.copilotToken = "test-token"
  const chunk = {
    id: "chat-null-usage",
    object: "chat.completion.chunk",
    created: 0,
    model: "gemini-test",
    choices: [
      {
        index: 0,
        delta: { content: "Hello" },
        finish_reason: "stop",
      },
    ],
    usage: null,
    copilot_usage: { total_nano_aiu: 10 },
  }
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }),
    ),
  ) as unknown as typeof fetch

  const app = new Hono()
  app.post("/stream", (c) => handleGenerateContent(c, "gemini-test", true))
  const response = await app.request("/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "Hi" }] }],
    }),
  })

  expect(response.status).toBe(200)
  const body = await response.text()
  expect(body).toContain('"text":"Hello"')
  expect(body).toContain('"finishReason":"STOP"')
  expect(body).not.toContain("usageMetadata")
})

test.each(["minimal", "low", "medium", "high"])(
  "Gemini sends thinking level %s in the actual Copilot request without a budget",
  async (level) => {
    await closeUsageStore()
    process.env.COPILOT_API_SQLITE_DB_PATH = ":memory:"
    const model = createFallbackModel("gemini-3.5-flash")
    model.capabilities.supports.reasoning_effort = [
      "minimal",
      "low",
      "medium",
      "high",
    ]
    state.models = { object: "list", data: [model] }
    state.copilotToken = "test-token"
    const requests: Array<Record<string, unknown>> = []
    globalThis.fetch = mock((_url: unknown, init?: RequestInit) => {
      if (typeof init?.body !== "string") {
        throw new Error("Expected a JSON string in the upstream request")
      }
      requests.push(JSON.parse(init.body) as Record<string, unknown>)
      return Promise.resolve(
        new Response(
          `data: ${JSON.stringify({
            id: "chat-thinking",
            object: "chat.completion.chunk",
            model: model.id,
            choices: [
              { index: 0, delta: { content: "Hello" }, finish_reason: "stop" },
            ],
          })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
      )
    }) as unknown as typeof fetch

    const app = new Hono()
    app.post("/stream", (c) => handleGenerateContent(c, model.id, true))
    const response = await app.request("/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hi" }] }],
        generationConfig: {
          thinkingConfig: { thinking_level: level.toUpperCase() },
        },
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"text":"Hello"')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toHaveProperty("reasoning_effort", level)
    expect(requests[0]).not.toHaveProperty("thinking_budget")
    expect(requests[0]).not.toHaveProperty("thinkingConfig")
  },
)
