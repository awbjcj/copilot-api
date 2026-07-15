import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import type { Model } from "~/services/copilot/get-models"

import { resolveMappedModel } from "~/lib/config"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { state } from "~/lib/state"
import {
  createCopilotTokenUsageRecorder,
  normalizeOpenAIUsage,
  normalizeOptionalToken,
  type UsageTokens,
} from "~/lib/token-usage"
import { generateRequestIdFromPayload, getUUID } from "~/lib/utils"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"

import type { GeminiPart, GeminiRequest } from "./gemini-types"
import {
  buildGeminiParts,
  chatResponseToGemini,
  convertGeminiToChatPayload,
  createGeminiStreamChunk,
  generateGeminiResponseId,
  mapFinishReason,
  validateGeminiRequest,
} from "./translation"

const logger = createHandlerLogger("gemini-handler")

/**
 * Resolves a requested Gemini model name to an available Copilot model id.
 * Applies the configured model mapping, then falls back to an exact match, a
 * loose Gemini-family match, and finally the requested name unchanged so the
 * backend can surface an authoritative error.
 */
function resolveGeminiModel(requestedModel: string): string {
  const mapped = resolveMappedModel(requestedModel)
  const models = state.models?.data ?? []

  const exact = models.find((m) => m.id === mapped)
  if (exact) return exact.id

  const lower = mapped.toLowerCase()
  if (lower.includes("gemini")) {
    const loose = models.find(
      (m) =>
        m.id.toLowerCase() === lower || m.id.toLowerCase().startsWith(lower),
    )
    if (loose) return loose.id

    const anyGemini = models.find((m) => m.id.toLowerCase().includes("gemini"))
    if (anyGemini) return anyGemini.id
  }

  consola.warn(
    `Gemini model "${requestedModel}" is not available in the Copilot catalog`
      + ` and no Gemini fallback was found. Sending "${mapped}" as-is; Copilot`
      + ` will likely reject it with a 400. Available models: `
      + models.map((m) => m.id).join(", "),
  )
  return mapped
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const parseChatCompletionChunk = (
  chunk: unknown,
): ChatCompletionChunk | null => {
  const data = (chunk as { data?: string }).data
  if (!data || data === "[DONE]") return null
  try {
    return JSON.parse(data) as ChatCompletionChunk
  } catch {
    return null
  }
}

interface StreamingToolCall {
  id: string
  name: string
  arguments: string
}

/**
 * Handles POST /v1beta/models/{model}:generateContent and
 * :streamGenerateContent. Converts the Gemini request to the internal OpenAI
 * chat-completions format, serves it through Copilot, and converts the response
 * back to the Gemini wire format.
 */
export async function handleGenerateContent(
  c: Context,
  requestedModelName: string,
  stream: boolean,
): Promise<Response> {
  const request = await c.req.json<GeminiRequest>()

  const validationError = validateGeminiRequest(request)
  if (validationError) {
    return c.json(
      {
        error: {
          code: 400,
          message: validationError,
          status: "INVALID_ARGUMENT",
        },
      },
      400,
    )
  }

  const model = resolveGeminiModel(requestedModelName)
  if (model !== requestedModelName) {
    consola.debug(`Resolved Gemini model: ${requestedModelName} -> ${model}`)
  }

  const payload = convertGeminiToChatPayload(request, model, stream)
  debugJson(logger, "Gemini request payload (as chat completions):", payload)

  const responseId = generateGeminiResponseId()
  const requestId = generateRequestIdFromPayload(payload)
  const sessionId = getUUID(requestId)

  const recordUsage = createCopilotTokenUsageRecorder({
    endpoint: "chat_completions",
    fallbackSessionId: sessionId,
    model,
  })

  const response = await createChatCompletions(payload, {
    requestId,
    sessionId,
  })

  if (isNonStreaming(response)) {
    debugJson(logger, "Gemini non-streaming upstream response:", response)
    recordUsage({
      ...normalizeOpenAIUsage(response.usage),
      total_nano_aiu: normalizeOptionalToken(
        response.copilot_usage?.total_nano_aiu,
      ),
    })
    return c.json(chatResponseToGemini(response, model, responseId))
  }

  logger.debug("Gemini streaming response")
  return streamSSE(c, async (sse) => {
    let usage: UsageTokens = {}
    let openAIUsage: ChatCompletionResponse["usage"]
    let finishReason: string | null | undefined
    const toolCalls = new Map<number, StreamingToolCall>()

    for await (const chunk of response) {
      const parsed = parseChatCompletionChunk(chunk)
      if (!parsed) continue
      debugJson(logger, "Gemini streaming chunk:", parsed)

      if (parsed.usage || parsed.copilot_usage) {
        openAIUsage = parsed.usage
        usage = {
          ...normalizeOpenAIUsage(parsed.usage),
          total_nano_aiu: normalizeOptionalToken(
            parsed.copilot_usage?.total_nano_aiu,
          ),
        }
      }

      const choice = parsed.choices[0]
      if (!choice) continue
      if (choice.finish_reason) finishReason = choice.finish_reason

      const delta = choice.delta
      if (delta.content) {
        await sse.writeSSE({
          data: JSON.stringify(
            createGeminiStreamChunk([{ text: delta.content }], {
              model,
              responseId,
            }),
          ),
        } satisfies SSEMessage)
      }

      for (const tc of delta.tool_calls ?? []) {
        const existing = toolCalls.get(tc.index) ?? {
          id: "",
          name: "",
          arguments: "",
        }
        if (tc.id) existing.id = tc.id
        if (tc.function?.name) existing.name = tc.function.name
        if (tc.function?.arguments) existing.arguments += tc.function.arguments
        toolCalls.set(tc.index, existing)
      }
    }

    // Emit accumulated tool calls (Gemini functionCall needs complete args).
    const finalParts: Array<GeminiPart> =
      toolCalls.size > 0 ?
        buildGeminiParts(
          null,
          [...toolCalls.values()].map((tc) => ({
            id: tc.id || `gemini-call-${tc.name}`,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments || "{}" },
          })),
        )
      : [{ text: "" }]

    await sse.writeSSE({
      data: JSON.stringify(
        createGeminiStreamChunk(finalParts, {
          model,
          responseId,
          finishReason: mapFinishReason(finishReason),
          usage:
            openAIUsage ?
              {
                promptTokenCount: openAIUsage.prompt_tokens,
                candidatesTokenCount: openAIUsage.completion_tokens,
                totalTokenCount: openAIUsage.total_tokens,
              }
            : undefined,
        }),
      ),
    } satisfies SSEMessage)

    recordUsage(usage)
  })
}

/**
 * Builds the Gemini model descriptor for a Copilot model.
 */
function toGeminiModelDescriptor(model: Model): Record<string, unknown> {
  const limits = model.capabilities?.limits
  return {
    name: `models/${model.id}`,
    version: model.version,
    displayName: model.name,
    description: `${model.name} via GitHub Copilot (${model.vendor})`,
    inputTokenLimit: limits?.max_context_window_tokens ?? 0,
    outputTokenLimit: limits?.max_output_tokens ?? 0,
    supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
  }
}

/**
 * Handles GET /v1beta/models (Gemini model list).
 */
export function handleListModels(c: Context): Response {
  const models = state.models?.data ?? []
  return c.json({ models: models.map(toGeminiModelDescriptor) })
}

/**
 * Handles GET /v1beta/models/{model} (Gemini single-model lookup).
 */
export function handleGetModel(
  c: Context,
  requestedModelName: string,
): Response {
  const models = state.models?.data ?? []
  const resolved = resolveGeminiModel(requestedModelName)
  const model = models.find((m) => m.id === resolved)
  if (!model) {
    return c.json(
      {
        error: {
          code: 404,
          message: `Model not found: ${requestedModelName}`,
          status: "NOT_FOUND",
        },
      },
      404,
    )
  }
  return c.json(toGeminiModelDescriptor(model))
}
