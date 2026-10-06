import type { Context } from "hono"
import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"
import { HTTPError } from "~/lib/error"
import { stripInternalRequestHeaders } from "~/lib/internal-headers"
import { writeSSEIfConnected } from "~/lib/sse"
import { getTokenCount } from "~/lib/tokenizer"
import { getAggregatedModels } from "~/routes/models/route"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ToolCall,
} from "~/lib/types/chat-completions"
import type {
  ResponsesResult,
  ResponseStreamEvent,
} from "~/lib/types/responses"
import type { GeminiPart, GeminiRequest, GeminiResponse } from "./gemini-types"
import { dispatchGemini, resolveGeminiModel } from "./dispatch"
import { GeminiError, geminiErrorBody } from "./errors"
import { isRecord, normalizeGeminiRequest } from "./validation"
import { responsesResultToGemini } from "./responses"
import {
  buildGeminiParts,
  chatResponseToGemini,
  convertGeminiToChatPayload,
  createGeminiStreamChunk,
  generateGeminiResponseId,
  mapFinishReason,
  validateGeminiRequest,
} from "./translation"

export const geminiHandlerDependencies = { dispatchGemini, getAggregatedModels }

/** Hide summaries when requested while preserving opaque state for the next turn. */
export function applyThoughtVisibility(
  result: GeminiResponse,
  include: boolean,
): GeminiResponse {
  if (include) return result
  for (const candidate of result.candidates) {
    const signatures: string[] = []
    candidate.content.parts = candidate.content.parts.filter((part) => {
      if (!("thought" in part) || !part.thought) return true
      if (part.thoughtSignature) signatures.push(part.thoughtSignature)
      return false
    })
    for (const signature of signatures)
      candidate.content.parts.push({ text: "", thoughtSignature: signature })
  }
  return result
}

/** Dispatch a validated Gemini request and translate its complete or streaming response. */
export async function generateGemini(
  c: Context,
  request: GeminiRequest,
  modelName: string,
  stream: boolean,
): Promise<Response> {
  request = normalizeGeminiRequest(request)
  const error = validateGeminiRequest(request)
  if (error) throw new GeminiError(error)
  const { response, dialect, model } =
    await geminiHandlerDependencies.dispatchGemini(
      c,
      request,
      modelName,
      stream,
    )
  if (!response.ok) throw new HTTPError("Upstream generation failed", response)
  const include =
    request.generationConfig?.thinkingConfig?.includeThoughts !== false
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const body = await response.json()
    const result =
      dialect === "chat" ?
        chatResponseToGemini(
          body as ChatCompletionResponse,
          model,
          generateGeminiResponseId(),
        )
      : responsesResultToGemini(body as ResponsesResult)
    applyThoughtVisibility(result, include)
    if (!stream) return c.json(result)
    return streamSSE(c, async (sse) => {
      await writeSSEIfConnected(sse, { data: JSON.stringify(result) })
    })
  }
  return streamSSE(c, async (sse) => {
    try {
      const chunks =
        dialect === "chat" ?
          translateChatStream(response, model)
        : translateResponsesStream(response)
      for await (const chunk of chunks) {
        if (
          !(await writeSSEIfConnected(sse, {
            data: JSON.stringify(applyThoughtVisibility(chunk, include)),
          }))
        )
          break
      }
    } catch (error) {
      await writeSSEIfConnected(sse, {
        data: JSON.stringify(await geminiErrorBody(error)),
      })
    }
  })
}

/** Parse and validate the generateContent HTTP request. */
export async function handleGenerateContent(
  c: Context,
  model: string,
  stream: boolean,
): Promise<Response> {
  return generateGemini(c, await c.req.json<GeminiRequest>(), model, stream)
}

/** Translate incremental chat text, preserving complete tool arguments and failures. */
export async function* translateChatStream(
  response: Response,
  model: string,
): AsyncGenerator<GeminiResponse> {
  const responseId = generateGeminiResponseId()
  const calls = new Map<number, ToolCall>()
  let finish: string | null = null
  let usage: ChatCompletionResponse["usage"]
  let signature: string | undefined
  for await (const event of events(response)) {
    if (!event.data || event.data === "[DONE]") continue
    const data = JSON.parse(event.data) as ChatCompletionChunk & {
      error?: { message?: string }
    }
    if (data.error)
      throw new GeminiError(data.error.message ?? "Upstream stream failed", 502)
    if (!Array.isArray(data.choices))
      throw new GeminiError("Invalid upstream chat stream", 502)
    if (data.usage) usage = data.usage
    const choice = data.choices[0]
    if (!choice) continue
    finish = choice.finish_reason ?? finish
    const delta = choice.delta
    if (delta.reasoning_opaque) signature = delta.reasoning_opaque
    const reasoning = delta.reasoning_text ?? delta.reasoning_content
    if (reasoning)
      yield createGeminiStreamChunk([{ text: reasoning, thought: true }], {
        model,
        responseId,
      })
    if (delta.content)
      yield createGeminiStreamChunk([{ text: delta.content }], {
        model,
        responseId,
      })
    for (const call of delta.tool_calls ?? []) {
      const current = calls.get(call.index) ?? {
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      }
      if (call.id) current.id = call.id
      if (call.function?.name) current.function.name += call.function.name
      if (call.function?.arguments)
        current.function.arguments += call.function.arguments
      calls.set(call.index, current)
    }
  }
  if (!finish)
    throw new GeminiError("Upstream stream ended before completion", 502)
  const toolCalls = [...calls.values()].map((call, index) => ({
    ...call,
    id: call.id || `${responseId}-call-${index}`,
  }))
  const parts = buildGeminiParts(null, toolCalls)
  if (signature) parts.unshift({ text: "", thoughtSignature: signature })
  yield createGeminiStreamChunk(parts, {
    model,
    responseId,
    finishReason: mapFinishReason(finish),
    usage:
      usage ?
        {
          promptTokenCount: usage.prompt_tokens,
          candidatesTokenCount: usage.completion_tokens,
          totalTokenCount: usage.total_tokens,
          cachedContentTokenCount: usage.prompt_tokens_details?.cached_tokens,
        }
      : undefined,
  })
}

/** Translate Responses SSE; final metadata is authoritative and text is never duplicated. */
export async function* translateResponsesStream(
  response: Response,
): AsyncGenerator<GeminiResponse> {
  let completed = false
  let textSent = false
  let thoughtsSent = false
  for await (const event of events(response)) {
    if (!event.data || event.data === "[DONE]") continue
    const data = JSON.parse(event.data) as ResponseStreamEvent
    if (data.type === "error")
      throw new GeminiError(data.message ?? "Upstream stream failed", 502)
    if (data.type === "response.failed")
      throw new GeminiError(
        data.response.error?.message ?? "Upstream generation failed",
        502,
      )
    if (data.type === "response.output_text.delta") {
      textSent = true
      yield createGeminiStreamChunk([{ text: data.delta }])
    } else if (data.type === "response.reasoning_summary_text.delta") {
      thoughtsSent = true
      yield createGeminiStreamChunk([{ text: data.delta, thought: true }])
    } else if (
      data.type === "response.completed"
      || data.type === "response.incomplete"
    ) {
      const result = responsesResultToGemini(data.response)
      const parts: GeminiPart[] = []
      for (const part of result.candidates[0].content.parts) {
        if ("functionCall" in part) parts.push(part)
        else if ("text" in part && (part.thought ? !thoughtsSent : !textSent))
          parts.push(part)
        else if ("thoughtSignature" in part && part.thoughtSignature)
          parts.push({ text: "", thoughtSignature: part.thoughtSignature })
      }
      result.candidates[0].content.parts = parts.length ? parts : [{ text: "" }]
      completed = true
      yield result
    }
  }
  if (!completed)
    throw new GeminiError("Upstream stream ended before completion", 502)
}

function descriptor(model: { id: string; [key: string]: unknown }) {
  const caps = model.capabilities as
    | {
        limits?: {
          max_context_window_tokens?: number
          max_output_tokens?: number
        }
      }
    | undefined
  return {
    name: `models/${model.id}`,
    version: model.version ?? model.id,
    displayName: model.name ?? model.id,
    inputTokenLimit: caps?.limits?.max_context_window_tokens ?? 0,
    outputTokenLimit: caps?.limits?.max_output_tokens ?? 0,
    supportedGenerationMethods: [
      "generateContent",
      "streamGenerateContent",
      "countTokens",
    ],
  }
}

/** List generative models from the same enabled provider catalog as OpenAI clients. */
export async function handleListModels(c: Context): Promise<Response> {
  const models = await geminiHandlerDependencies.getAggregatedModels(
    stripInternalRequestHeaders(c.req.raw.headers),
  )
  return c.json({
    models: models
      .filter(
        (m) =>
          (m.capabilities as { type?: string } | undefined)?.type
            !== "embeddings" && !m.id.includes("embedding"),
      )
      .map(descriptor),
  })
}

/** Resolve a model lookup without substituting an unrelated Gemini model. */
export async function handleGetModel(
  c: Context,
  name: string,
): Promise<Response> {
  const resolved = await resolveGeminiModel(name)
  return c.json(descriptor({ ...resolved.model, id: resolved.id }))
}

/** Estimate tokens locally, including history and tools; this is not Google's tokenizer. */
export async function handleCountTokens(
  c: Context,
  name: string,
): Promise<Response> {
  const body = await c.req.json<
    | GeminiRequest
    | { generateContentRequest: GeminiRequest & { model?: string } }
  >()
  const request = normalizeGeminiRequest(
    isRecord(body) && "generateContentRequest" in body ?
      { ...body.generateContentRequest }
    : body,
  )
  if (isRecord(request) && "model" in request) delete request.model
  const error = validateGeminiRequest(request)
  if (error) throw new GeminiError(error)
  const resolved = await resolveGeminiModel(name)
  const count = await getTokenCount(
    convertGeminiToChatPayload(request, resolved.id, false),
    resolved.model,
  )
  c.header("x-copilot-api-token-count", "estimated")
  return c.json({ totalTokens: count.input + count.output })
}
