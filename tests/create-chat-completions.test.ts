import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import consola from "consola"
import { Hono } from "hono"

import type { ChatCompletionsPayload } from "~/lib/types/chat-completions"

import { state } from "~/lib/state"
import { forwardError, HTTPError } from "~/lib/error"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"

const originalFetch = globalThis.fetch
const originalState = {
  accountType: state.accountType,
  copilotToken: state.copilotToken,
  vsCodeVersion: state.vsCodeVersion,
}

test("HTTP error forwarding returns diagnostics to the caller without logging bodies", async () => {
  const errorLog = spyOn(consola, "error").mockImplementation(
    Object.assign(() => {}, { raw: () => {} }),
  )
  const app = new Hono()
  app.get("/", (c) =>
    forwardError(
      c,
      new HTTPError(
        "private-error-message",
        new Response("private-echoed-prompt", { status: 400 }),
      ),
    ),
  )
  try {
    const response = await app.request("/")
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { message: "private-echoed-prompt" },
    })
    expect(JSON.stringify(errorLog.mock.calls)).toContain("400")
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("private-")
  } finally {
    errorLog.mockRestore()
  }
})

test("failed completions never log prompts, tools or echoed error bodies", async () => {
  const errorLog = spyOn(consola, "error").mockImplementation(
    Object.assign(() => {}, { raw: () => {} }),
  )
  const response = new Response("echoed-secret-prompt", {
    status: 400,
    statusText: "echoed-secret-status",
  })
  globalThis.fetch = mock(() =>
    Promise.resolve(response),
  ) as unknown as typeof fetch
  try {
    const error = await createChatCompletions(
      {
        model: "gpt-test",
        messages: [{ role: "user", content: "private-prompt" }],
        tools: [
          {
            type: "function",
            function: {
              name: "tool",
              description: "private-tool-schema",
              parameters: { type: "object" },
            },
          },
        ],
      },
      { requestId: "test" },
    ).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("Failed to create chat completions")
    const logs = JSON.stringify(errorLog.mock.calls)
    expect(logs).toContain("HTTP 400")
    for (const secret of [
      "echoed-secret-prompt",
      "private-prompt",
      "private-tool-schema",
      "echoed-secret-status",
    ])
      expect(logs).not.toContain(secret)
  } finally {
    errorLog.mockRestore()
  }
})

// Helper to mock fetch
const fetchMock = mock(
  (_url: string, opts: { headers: Record<string, string> }) => {
    return {
      ok: true,
      json: () => ({ id: "123", object: "chat.completion", choices: [] }),
      headers: opts.headers,
    }
  },
)
beforeEach(() => {
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  state.copilotToken = originalState.copilotToken
  state.vsCodeVersion = originalState.vsCodeVersion
  state.accountType = originalState.accountType
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

test("sets x-initiator to agent if tool/assistant present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", content: "tool call" },
    ],
    model: "gpt-test",
  }
  await createChatCompletions(payload, { requestId: "1" })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["x-initiator"]).toBe("agent")
})

test("sets x-initiator to user if only user present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "user", content: "hello again" },
    ],
    model: "gpt-test",
  }
  await createChatCompletions(payload, { requestId: "1" })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["x-initiator"]).toBe("user")
})
