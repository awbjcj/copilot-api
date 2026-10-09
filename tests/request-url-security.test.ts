import { afterEach, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import { createAuthMiddleware } from "~/lib/request-auth"
import { createRequestLogger } from "~/lib/request-logger"
import { withoutGatewayQueryKey } from "~/lib/request-url"
import { resolveCodexAlphaSearchUrl } from "~/services/codex/alpha-search"
import { resolveCodexModelsUrl } from "~/services/codex/get-models"
import { resolveCodexImagesUrl } from "~/services/codex/images"
import {
  forwardProviderAlphaSearch,
  forwardProviderImages,
} from "~/services/providers/provider-proxy"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test("request logs redact retired query keys even when authentication fails", async () => {
  const logs: Array<string> = []
  const app = new Hono()
  app.use(createRequestLogger((message) => logs.push(message)))
  app.use(createAuthMiddleware({ getApiKeys: () => ["secret-one"] }))
  app.get("/v1beta/models", (c) => c.json({ ok: true }))

  const response = await app.request(
    "/v1beta/models?key=secret-one&%6bey=secret-two&alt=sse",
  )
  expect(response.status).toBe(401)
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

test("models.dev image and search endpoints strip gateway credentials without duplicating API paths", async () => {
  const fetchMock = mock((_input: unknown, _init?: RequestInit) =>
    Promise.resolve(Response.json({ ok: true })),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  for (const baseUrl of [
    "https://provider.example/api/v1",
    "https://provider.example/api/v1/chat/completions",
    "https://provider.example/api/v1/responses",
  ]) {
    const providerConfig = {
      name: "custom",
      type: "openai-compatible" as const,
      authType: "authorization" as const,
      apiKey: "provider-key",
      baseUrl,
      modelsDevProviderId: "custom",
    }
    for (const endpoint of [
      "images/generations",
      "images/edits",
      "alpha/search",
    ]) {
      const request = new Request(
        `http://gateway/v1/${endpoint}?%6bey=gateway-secret&key=other-secret&size=large&x=a%20b`,
        { method: "POST", body: "{}" },
      )
      const response =
        endpoint === "alpha/search" ?
          await forwardProviderAlphaSearch(providerConfig, request)
        : await forwardProviderImages(
            providerConfig,
            request,
            endpoint === "images/edits" ? "edits" : "generations",
          )
      await response.text()
      const lastCall = fetchMock.mock.calls.at(-1)
      expect(lastCall?.[0]).toBe(
        `https://provider.example/api/v1/${endpoint}?size=large&x=a+b`,
      )
      expect(lastCall?.[1]?.headers).toHaveProperty(
        "authorization",
        "Bearer provider-key",
      )
    }
  }
})
