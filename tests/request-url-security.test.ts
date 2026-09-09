import { afterEach, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import { createAuthMiddleware } from "~/lib/request-auth"
import { createRequestLogger } from "~/lib/request-logger"
import { withoutGatewayQueryKey } from "~/lib/request-url"
import { resolveCodexAlphaSearchUrl } from "~/services/codex/alpha-search"
import { resolveCodexModelsUrl } from "~/services/codex/get-models"
import { resolveCodexImagesUrl } from "~/services/codex/images"
import { forwardProviderImages } from "~/services/providers/provider-proxy"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test("request logs omit query keys while query authentication still works", async () => {
  const logs: Array<string> = []
  const app = new Hono()
  app.use(createRequestLogger((message) => logs.push(message)))
  app.use(createAuthMiddleware({ getApiKeys: () => ["secret-one"] }))
  app.get("/v1beta/models", (c) => c.json({ ok: true }))

  const response = await app.request(
    "/v1beta/models?key=secret-one&%6bey=secret-two&alt=sse",
  )
  expect(response.status).toBe(200)
  expect(logs).toHaveLength(2)
  for (const log of logs) {
    expect(log).toContain("/v1beta/models?alt=sse")
    expect(log).not.toContain("secret")
    expect(log).not.toContain("key=")
  }
})

test("URL sanitization preserves ordinary query encoding and no-query paths", () => {
  expect(withoutGatewayQueryKey("/images?x=a%20b").search).toBe("?x=a%20b")
  expect(withoutGatewayQueryKey("/images").pathname).toBe("/images")
  expect(withoutGatewayQueryKey("/images?key=secret").search).toBe("")
})

test("Codex upstream URLs remove all gateway query keys", () => {
  const requestUrl = "http://gateway/path?%6bey=secret&key=other&limit=10"
  const urls = [
    resolveCodexAlphaSearchUrl(requestUrl),
    resolveCodexModelsUrl(requestUrl),
    resolveCodexImagesUrl(requestUrl, "generations"),
    resolveCodexImagesUrl(requestUrl, "edits"),
  ]
  for (const url of urls) {
    expect(new URL(url).search).toBe("?limit=10")
  }
})

test("provider image forwarding strips gateway query credentials", async () => {
  const fetchMock = mock((_input: unknown, _init?: RequestInit) =>
    Promise.resolve(Response.json({ ok: true })),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch
  await forwardProviderImages(
    {
      name: "custom",
      type: "openai-compatible",
      authType: "authorization",
      apiKey: "provider-key",
      baseUrl: "https://provider.example",
    },
    new Request("http://gateway/images?key=gateway-secret&size=large", {
      method: "POST",
      body: "{}",
    }),
    "generations",
  )
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    "https://provider.example/v1/images/generations?size=large",
  )
  expect(fetchMock.mock.calls[0]?.[1]?.headers).toHaveProperty(
    "authorization",
    "Bearer provider-key",
  )
})
