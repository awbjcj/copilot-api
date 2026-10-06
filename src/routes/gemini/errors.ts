import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import {
  HTTPError,
  UpstreamHeadersTimeoutError,
  UpstreamStreamInactivityTimeoutError,
} from "~/lib/error"

/** A client-facing Gemini protocol error. */
export class GeminiError extends Error {
  code: ContentfulStatusCode
  constructor(message: string, code: ContentfulStatusCode = 400) {
    super(message)
    this.code = code
  }
}

const statuses: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  409: "ALREADY_EXISTS",
  429: "RESOURCE_EXHAUSTED",
  499: "CANCELLED",
  500: "INTERNAL",
  501: "UNIMPLEMENTED",
  502: "INTERNAL",
  503: "UNAVAILABLE",
  504: "DEADLINE_EXCEEDED",
}

/** Normalize transport and validation failures without exposing internal stack traces. */
export async function geminiErrorBody(error: unknown) {
  let code: ContentfulStatusCode = 500
  let message = "Internal server error"
  if (error instanceof GeminiError) {
    code = error.code
    message = error.message
  } else if (error instanceof SyntaxError) {
    code = 400
    message = "Request body must be valid JSON"
  } else if (error instanceof HTTPError) {
    code = error.response.status as ContentfulStatusCode
    const body: unknown = await error.response
      .clone()
      .json()
      .catch(() => null)
    const upstream = body as { error?: { message?: unknown } } | null
    message =
      typeof upstream?.error?.message === "string" ?
        upstream.error.message
      : error.message
  } else if (
    error instanceof UpstreamHeadersTimeoutError
    || error instanceof UpstreamStreamInactivityTimeoutError
  ) {
    code = 504
    message = error.message
  } else if (error instanceof Error && error.name === "AbortError") {
    code = 499 as ContentfulStatusCode
    message = "Request cancelled"
  }
  return { error: { code, message, status: statuses[code] ?? "UNKNOWN" } }
}

/** Return the canonical Google error envelope and preserve upstream retry hints. */
export async function forwardGeminiError(
  c: Context,
  error: unknown,
): Promise<Response> {
  if (error instanceof HTTPError) {
    const retry = error.response.headers.get("retry-after")
    if (retry) c.header("retry-after", retry)
  }
  const body = await geminiErrorBody(error)
  return c.json(body, body.error.code)
}
