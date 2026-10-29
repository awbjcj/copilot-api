import type { ConsolaInstance } from "consola"

import type { ResolvedProviderConfig } from "~/lib/config"
import { debugJson, debugJsonAsync } from "~/lib/logger"
import type { CodexImagesOperation } from "~/services/codex/images"
import {
  createProviderProxyResponse,
  forwardProviderImages,
} from "~/services/providers/provider-proxy"
import { ensureImageResponseB64Json } from "~/services/xai/images"

export interface ProviderImagesForwardLogContext {
  logger: ConsolaInstance
  provider: string
}

/**
 * Forwards an images request to a configured provider with debug logging.
 * Shared by the top-level images routes (model mapping) and the
 * provider-scoped images routes so both log and proxy identically.
 */
export async function forwardProviderImagesWithLogging(
  providerConfig: ResolvedProviderConfig,
  request: Request,
  operation: CodexImagesOperation,
  { logger, provider }: ProviderImagesForwardLogContext,
): Promise<Response> {
  if (operation === "generations") {
    await debugJsonAsync(
      logger,
      `provider.images.${operation}.request`,
      async () => ({
        body: await request.clone().text(),
        provider,
      }),
    )
  } else {
    debugJson(logger, `provider.images.${operation}.request`, {
      contentType: request.headers.get("content-type"),
      contentLength: request.headers.get("content-length"),
      provider,
    })
  }

  const upstreamResponse = await forwardProviderImages(
    providerConfig,
    request,
    operation,
  )
  debugJson(logger, `provider.images.${operation}.response`, {
    contentType: upstreamResponse.headers.get("content-type"),
    contentLength: upstreamResponse.headers.get("content-length"),
    provider,
    statusCode: upstreamResponse.status,
  })
  return createProviderProxyResponse(upstreamResponse)
}

/** Forwards translated xAI requests and normalizes OpenAI-compatible output. */
export async function forwardXaiImagesWithLogging(
  providerConfig: ResolvedProviderConfig,
  request: Request,
  operation: CodexImagesOperation,
  payload: Record<string, unknown>,
  { logger, provider }: ProviderImagesForwardLogContext,
): Promise<Response> {
  const upstreamRequest = new Request(request.url, {
    body: JSON.stringify(payload),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    method: "POST",
    signal: request.signal,
  })
  const upstreamResponse = await forwardProviderImagesWithLogging(
    providerConfig,
    upstreamRequest,
    operation,
    { logger, provider },
  )
  return await ensureImageResponseB64Json(upstreamResponse, undefined, {
    clientSignal: request.signal,
    onImageUrl: (url) => {
      logger.info("images.xai.output.url", JSON.stringify({ operation, url }))
    },
    responseFormat: payload.response_format === "url" ? "url" : "b64_json",
  })
}
