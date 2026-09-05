import consola from "consola"
import { Hono, type Context } from "hono"
import { bufferToFormData } from "hono/utils/buffer"

import { resolveMappedModel, type ResolvedProviderConfig } from "~/lib/config"
import { forwardError } from "~/lib/error"
import { createHandlerLogger, debugJson, debugJsonAsync } from "~/lib/logger"
import { parseProviderModelAlias } from "~/lib/provider-model"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import {
  forwardCodexImages,
  type CodexImagesOperation,
} from "~/services/codex/images"
import { createProviderProxyResponse } from "~/services/providers/provider-proxy"
import { forwardProviderImagesWithLogging } from "~/routes/images/forward-provider-images"

const logger = createHandlerLogger("images-handler")

export const imageRoutes = new Hono()
export const imageRouteDependencies = {
  debugJsonAsync,
  resolveMappedModel,
  resolveProviderConfig,
}

interface ParsedImagesRequest {
  createRequest: (model: string) => Request
  model: string
  originalRequest: Request
}

function getContentMetadata(headers: Headers) {
  return {
    contentType: headers.get("content-type"),
    contentLength: headers.get("content-length"),
  }
}

function createJsonImagesRequest(
  request: Request,
  requestHeaders: Headers,
  payload: Record<string, unknown>,
  model: string,
): Request {
  const headers = new Headers(requestHeaders)
  headers.delete("content-length")

  return new Request(request.url, {
    body: JSON.stringify({ ...payload, model }),
    headers,
    method: request.method,
    signal: request.signal,
  })
}

function createBufferedImagesRequest(
  request: Request,
  requestHeaders: Headers,
  body: ArrayBuffer,
): Request {
  return new Request(request.url, {
    body,
    headers: requestHeaders,
    method: request.method,
    signal: request.signal,
  })
}

function createMultipartImagesRequest(
  request: Request,
  requestHeaders: Headers,
  formData: Awaited<ReturnType<typeof bufferToFormData>>,
  model: string,
): Request {
  formData.set("model", model)
  const headers = new Headers(requestHeaders)
  headers.delete("content-length")
  headers.delete("content-type")

  return new Request(request.url, {
    body: formData,
    headers,
    method: request.method,
    signal: request.signal,
  })
}

async function parseImagesRequest(
  request: Request,
): Promise<ParsedImagesRequest | Request> {
  // Bun drops auto-generated body headers after consuming the request body.
  // Snapshot them first so unchanged multipart uploads keep their boundary.
  const requestHeaders = new Headers(request.headers)
  const contentType = requestHeaders.get("content-type")
  // Routing on the model field requires reading the body up front, so uploads
  // are fully buffered here instead of streamed; image payloads are bounded
  // by practical upload sizes, and the buffer is reused for forwarding below.
  const body = await request.arrayBuffer()
  const originalRequest = createBufferedImagesRequest(
    request,
    requestHeaders,
    body,
  )
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase()
  if (mediaType === "multipart/form-data" && contentType) {
    try {
      const formData = await bufferToFormData(body, contentType)
      const model = formData.get("model")
      if (typeof model !== "string") return originalRequest

      return {
        createRequest: (mappedModel) =>
          createMultipartImagesRequest(
            request,
            requestHeaders,
            formData,
            mappedModel,
          ),
        model,
        originalRequest,
      }
    } catch {
      return originalRequest
    }
  }

  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(body))
    if (
      payload === null
      || typeof payload !== "object"
      || Array.isArray(payload)
      || typeof (payload as { model?: unknown }).model !== "string"
    ) {
      return originalRequest
    }

    const model = (payload as { model: string }).model
    return {
      createRequest: (mappedModel) =>
        createJsonImagesRequest(
          request,
          requestHeaders,
          payload as Record<string, unknown>,
          mappedModel,
        ),
      model,
      originalRequest,
    }
  } catch {
    return originalRequest
  }
}

/**
 * Handles Codex images proxying. Pass `resolvedProviderConfig` when the
 * caller already resolved the codex provider to avoid a second resolve, and
 * pass `request` when model mapping rebuilt the request body.
 */
export async function handleCodexImages(
  c: Context,
  operation: CodexImagesOperation,
  resolvedProviderConfig?: ResolvedProviderConfig,
  request: Request = c.req.raw,
): Promise<Response> {
  try {
    const codexProviderConfig =
      resolvedProviderConfig
      ?? (await imageRouteDependencies.resolveProviderConfig("codex"))
    if (!codexProviderConfig) {
      return c.json(
        {
          error: {
            message: "Provider 'codex' not found or disabled",
            type: "invalid_request_error",
          },
        },
        404,
      )
    }

    if (operation === "generations") {
      await imageRouteDependencies.debugJsonAsync(
        logger,
        "images.generations.codex.request",
        async () => ({
          body: await request.clone().text(),
        }),
      )
    } else {
      debugJson(
        logger,
        "images.edits.codex.request",
        getContentMetadata(request.headers),
      )
    }

    const upstreamResponse = await forwardCodexImages(request, operation)
    debugJson(logger, `images.${operation}.codex.response`, {
      ...getContentMetadata(upstreamResponse.headers),
      statusCode: upstreamResponse.status,
    })
    return createProviderProxyResponse(upstreamResponse)
  } catch (error) {
    logger.error(`images.${operation}.codex.error`, { error })
    return await forwardError(c, error)
  }
}

async function handleImagesRequest(
  c: Context,
  operation: CodexImagesOperation,
): Promise<Response> {
  try {
    const parsedRequest = await parseImagesRequest(c.req.raw)
    if (parsedRequest instanceof Request) {
      return await handleCodexImages(c, operation, undefined, parsedRequest)
    }

    const requestedModel = parsedRequest.model
    const mappedModel =
      imageRouteDependencies.resolveMappedModel(requestedModel)
    if (mappedModel !== requestedModel) {
      consola.debug(
        `Resolved model mapping: ${requestedModel} -> ${mappedModel}`,
      )
    }

    const providerModelAlias = parseProviderModelAlias(mappedModel)
    if (providerModelAlias) {
      const providerConfig = await imageRouteDependencies.resolveProviderConfig(
        providerModelAlias.provider,
      )
      if (providerConfig) {
        const request = parsedRequest.createRequest(providerModelAlias.model)
        if (providerConfig.name === "codex") {
          return await handleCodexImages(c, operation, providerConfig, request)
        }

        return await forwardProviderImagesWithLogging(
          providerConfig,
          request,
          operation,
          { logger, provider: providerModelAlias.provider },
        )
      }

      // The mapped provider is not configured: keep the pre-mapping behavior
      // and forward the client-sent model to Codex, not the prefixed alias.
      consola.debug(
        `Provider '${providerModelAlias.provider}' not found or disabled; forwarding the original model to Codex`,
      )
      return await handleCodexImages(
        c,
        operation,
        undefined,
        parsedRequest.originalRequest,
      )
    }

    const request =
      mappedModel === requestedModel ?
        parsedRequest.originalRequest
      : parsedRequest.createRequest(mappedModel)
    return await handleCodexImages(c, operation, undefined, request)
  } catch (error) {
    logger.error(`images.${operation}.error`, { error })
    return await forwardError(c, error)
  }
}

imageRoutes.post("/generations", (c) => handleImagesRequest(c, "generations"))
imageRoutes.post("/edits", (c) => handleImagesRequest(c, "edits"))
