import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import {
  handleGenerateContent,
  handleGetModel,
  handleListModels,
} from "./handler"

export const geminiRoutes = new Hono()

// GET /v1beta/models - list available models (Gemini shape)
geminiRoutes.get("/models", (c) => {
  try {
    return handleListModels(c)
  } catch (error) {
    return forwardError(c, error)
  }
})

// POST /v1beta/models/{model}:generateContent | :streamGenerateContent
// The `{model}:{method}` spec is a single path segment (model ids have no
// slashes), so it is captured whole and split on the last colon.
geminiRoutes.post("/models/:spec", async (c) => {
  const spec = c.req.param("spec")
  const colonIndex = spec.lastIndexOf(":")
  const modelName = colonIndex === -1 ? spec : spec.slice(0, colonIndex)
  const method = colonIndex === -1 ? "" : spec.slice(colonIndex + 1)
  const decodedModel = decodeURIComponent(modelName)

  if (method !== "generateContent" && method !== "streamGenerateContent") {
    return c.json(
      {
        error: {
          code: 404,
          message: `Unsupported Gemini method: ${method || "(none)"}`,
          status: "NOT_FOUND",
        },
      },
      404,
    )
  }

  try {
    return await handleGenerateContent(
      c,
      decodedModel,
      method === "streamGenerateContent",
    )
  } catch (error) {
    return forwardError(c, error)
  }
})

// GET /v1beta/models/{model} - single-model lookup
geminiRoutes.get("/models/:model", (c) => {
  try {
    return handleGetModel(c, decodeURIComponent(c.req.param("model")))
  } catch (error) {
    return forwardError(c, error)
  }
})
