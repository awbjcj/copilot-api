import type { MiddlewareHandler } from "hono"
import { logger } from "hono/logger"

import { withoutGatewayQueryKey } from "./request-url"

/** Keeps Gemini query credentials out of both incoming and outgoing logs. */
export function createRequestLogger(
  print: (message: string) => void = console.log,
): MiddlewareHandler {
  return async (c, next) => {
    const rawUrl = c.req.url
    const target = rawUrl.slice(rawUrl.indexOf("/", 8))
    const safeUrl = withoutGatewayQueryKey(rawUrl)
    const safeTarget = `${safeUrl.pathname}${safeUrl.search}`
    return logger((message) => {
      print(message.replace(target, () => safeTarget))
    })(c, next)
  }
}
