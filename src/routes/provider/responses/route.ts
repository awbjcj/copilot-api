import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { readResponsesPayload } from "~/routes/responses/request"
import { zstdDecompressionMiddleware } from "~/lib/zstd-request"

import { handleProviderResponsesForProvider } from "./handler"

export const providerResponsesRoutes = new Hono()

providerResponsesRoutes.use(zstdDecompressionMiddleware)

providerResponsesRoutes.post("/", async (c) => {
  try {
    const provider = c.req.param("provider") ?? ""
    const payload = await readResponsesPayload(c)
    if (payload instanceof Response) return payload
    return await handleProviderResponsesForProvider(c, { payload, provider })
  } catch (error) {
    return await forwardError(c, error)
  }
})
