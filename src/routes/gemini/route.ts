import { Hono } from "hono"

import { forwardGeminiError, GeminiError } from "./errors"
import { handleInteraction } from "./interactions"

import {
  handleGenerateContent,
  handleGetModel,
  handleListModels,
  handleCountTokens,
} from "./handler"

export const geminiRoutes = new Hono()

geminiRoutes.post("/interactions", async (c) => {
  try {
    return await handleInteraction(c)
  } catch (error) {
    return forwardGeminiError(c, error)
  }
})

geminiRoutes.all("/interactions/*", (c) =>
  forwardGeminiError(
    c,
    new GeminiError(
      "Stored interactions and background jobs are not supported",
      501,
    ),
  ),
)

// GET /v1beta/models - list available models (Gemini shape)
geminiRoutes.get("/models", async (c) => {
  try {
    return await handleListModels(c)
  } catch (error) {
    return forwardGeminiError(c, error)
  }
})

// POST /v1beta/models/{model}:generateContent | :streamGenerateContent
// Provider aliases may contain slashes; split the method from the last colon.
geminiRoutes.post("/models/*", async (c) => {
  const spec = c.req.path.split("/models/").slice(1).join("/models/")
  const colonIndex = spec.lastIndexOf(":")
  const modelName = colonIndex === -1 ? spec : spec.slice(0, colonIndex)
  const method = colonIndex === -1 ? "" : spec.slice(colonIndex + 1)

  if (
    !["generateContent", "streamGenerateContent", "countTokens"].includes(
      method,
    )
  ) {
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
    const decodedModel = decodeURIComponent(modelName)
    if (method === "countTokens")
      return await handleCountTokens(c, decodedModel)
    return await handleGenerateContent(
      c,
      decodedModel,
      method === "streamGenerateContent",
    )
  } catch (error) {
    return forwardGeminiError(c, error)
  }
})

// GET /v1beta/models/{model} - single-model lookup
geminiRoutes.get("/models/*", async (c) => {
  try {
    return await handleGetModel(
      c,
      decodeURIComponent(
        c.req.path.split("/models/").slice(1).join("/models/"),
      ),
    )
  } catch (error) {
    return forwardGeminiError(c, error)
  }
})
