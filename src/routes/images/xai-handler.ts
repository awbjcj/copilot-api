import type { Context } from "hono"

import { forwardXaiImagesWithLogging } from "~/routes/images/forward-provider-images"
import { imageRouteDependencies, logger } from "~/routes/images/shared"
import type { CodexImagesOperation } from "~/services/codex/images"
import {
  translateXaiImageEditJson,
  translateXaiImageGeneration,
  XaiImagesRequestError,
} from "~/services/xai/images"

export function xaiImagesRequestErrorResponse(
  c: Context,
  error: unknown,
): Response | null {
  if (!(error instanceof XaiImagesRequestError)) return null

  return c.json(
    {
      error: {
        message: error.message,
        type: "invalid_request_error",
      },
    },
    400,
  )
}

async function readJsonBody(
  request: Request,
  message: string,
): Promise<unknown> {
  try {
    const body = new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(await request.arrayBuffer()),
    )
    return JSON.parse(body)
  } catch {
    throw new XaiImagesRequestError(message)
  }
}

async function forwardTranslatedXaiImages(
  c: Context,
  operation: CodexImagesOperation,
  payload: Record<string, unknown>,
): Promise<Response> {
  const providerConfig =
    await imageRouteDependencies.resolveProviderConfig("xai")
  if (!providerConfig) {
    return c.json(
      {
        error: {
          message: "Provider 'xai' not found or disabled",
          type: "invalid_request_error",
        },
      },
      404,
    )
  }

  return await forwardXaiImagesWithLogging(
    providerConfig,
    c.req.raw,
    operation,
    payload,
    { logger, provider: "xai" },
  )
}

export async function handleXaiImageGeneration(
  c: Context,
  model: string,
): Promise<Response> {
  const payload = translateXaiImageGeneration(
    await readJsonBody(c.req.raw, "Image generation body must be JSON"),
    model,
  )
  return await forwardTranslatedXaiImages(c, "generations", payload)
}

export async function handleXaiImageEdit(
  c: Context,
  model: string,
  multipartPayload?: Record<string, unknown>,
): Promise<Response> {
  const payload = translateXaiImageEditJson(
    multipartPayload
      ?? (await readJsonBody(c.req.raw, "Image edit body must be JSON")),
    model,
  )
  return await forwardTranslatedXaiImages(c, "edits", payload)
}
