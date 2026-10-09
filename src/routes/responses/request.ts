import type { Context } from "hono"

import type { ResponsesPayload } from "~/lib/types/responses"

/** Validate the request before model routing or upstream calls. */
export async function readResponsesPayload(
  c: Context,
): Promise<ResponsesPayload | Response> {
  let payload: unknown
  try {
    payload = await c.req.json<unknown>()
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    return c.json(
      {
        error: {
          message: "Invalid JSON in request body.",
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  if (
    !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || !("model" in payload)
    || typeof payload.model !== "string"
    || payload.model.trim().length === 0
  ) {
    return c.json(
      {
        error: {
          message: "The 'model' field must be a non-empty string.",
          type: "invalid_request_error",
          param: "model",
        },
      },
      400,
    )
  }

  return payload as ResponsesPayload
}
