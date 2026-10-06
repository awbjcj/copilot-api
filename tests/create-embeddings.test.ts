import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import { state } from "~/lib/state"
import { createEmbeddings } from "~/services/copilot/create-embeddings"

const originalFetch = globalThis.fetch
const originalToken = state.copilotToken

const fetchMock = mock((_url: string, _opts: { body: string }) => ({
  ok: true,
  json: () => ({
    object: "list",
    data: [],
    model: "text-embedding-3-small",
    usage: { prompt_tokens: 1, total_tokens: 1 },
  }),
}))

function sentBody(): { input: unknown; model: string } {
  const opts = fetchMock.mock.calls[0][1]
  return JSON.parse(opts.body) as { input: unknown; model: string }
}

beforeEach(() => {
  state.copilotToken = "test-token"
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  state.copilotToken = originalToken
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
})

test("wraps a string input into an array", async () => {
  await createEmbeddings({ model: "text-embedding-3-small", input: "hello" })
  expect(sentBody()).toEqual({
    model: "text-embedding-3-small",
    input: ["hello"],
  })
})

test("passes array input through unchanged", async () => {
  await createEmbeddings({
    model: "text-embedding-3-small",
    input: ["a", "b"],
  })
  expect(sentBody().input).toEqual(["a", "b"])
})

test("throws when the copilot token is missing", async () => {
  state.copilotToken = undefined
  const error = await createEmbeddings({
    model: "text-embedding-3-small",
    input: "x",
  }).catch((error_: unknown) => error_)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe("Copilot token not found")
})
