import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  Message,
  Tool,
  ToolCall,
} from "~/services/copilot/create-chat-completions"

import type {
  GeminiErrorResponse,
  GeminiFinishReason,
  GeminiPart,
  GeminiRequest,
  GeminiResponse,
  GeminiTool,
  GeminiUsageMetadata,
} from "./gemini-types"

/**
 * Fallback reasoning text used when a thought part carries only a signature
 * (no text). Gemini 3 thinking emits signature-only thoughts on tool-calling
 * turns; emitting an empty thought would make some clients (e.g.
 * langchain-google-genai) build a reasoning block without a `reasoning` field,
 * which then crashes on the next round-trip. A non-empty text avoids that.
 */
export const GEMINI_THINKING_TEXT = "Thinking..."

interface GeminiReasoning {
  text?: string | null
  signature?: string | null
}

/**
 * Type guard for a Gemini "thought" (reasoning) part: a text part flagged with
 * `thought: true`.
 */
function isGeminiThoughtPart(
  part: GeminiPart,
): part is { text: string; thought?: boolean; thoughtSignature?: string } {
  return (
    typeof (part as { text?: unknown }).text === "string"
    && (part as { thought?: unknown }).thought === true
  )
}

/**
 * Collects reasoning text and signature from the thought parts of a turn.
 * Returns undefined when there are no thought parts.
 */
function geminiPartsReasoning(
  parts: Array<GeminiPart>,
): GeminiReasoning | undefined {
  const thoughts = parts.filter(isGeminiThoughtPart)
  if (thoughts.length === 0) return undefined
  const text = thoughts.map((p) => p.text).join("")
  const signature = thoughts.map((p) => p.thoughtSignature).find(Boolean)
  return { text: text || null, signature: signature ?? null }
}

/**
 * Synthesizes a stable tool-call id from a function name. Gemini function
 * calls/responses have no ids and are correlated by name, but the internal
 * (OpenAI) format correlates tool calls and their results by id. Deriving the
 * id from the name keeps calls and their responses matched.
 *
 * Limitation: multiple concurrent calls to the same function in one turn share
 * an id. This is an accepted edge case; distinct function names are the norm.
 */
export function geminiToolCallId(name: string): string {
  return `gemini-call-${name}`
}

/**
 * Generates a unique response id for Gemini responses.
 */
export function generateGeminiResponseId(): string {
  return `gemini-${Math.random().toString(36).slice(2, 15)}`
}

/**
 * Parses a Gemini request body safely.
 */
export function parseGeminiRequestBody(body: string): GeminiRequest | null {
  try {
    return JSON.parse(body) as GeminiRequest
  } catch {
    return null
  }
}

/**
 * Validates a Gemini generateContent request.
 */
export function validateGeminiRequest(request: GeminiRequest): string | null {
  if (!Array.isArray(request.contents)) {
    return "contents is required and must be an array"
  }
  if (request.contents.length === 0) {
    return "contents array cannot be empty"
  }
  for (const [i, content] of request.contents.entries()) {
    if (!content || !Array.isArray(content.parts)) {
      return `contents[${i}].parts is required and must be an array`
    }
    if (
      content.role !== undefined
      && !["user", "model"].includes(content.role)
    ) {
      return `contents[${i}].role must be 'user' or 'model'`
    }
  }
  if (request.tools !== undefined && !Array.isArray(request.tools)) {
    return "tools must be an array"
  }
  return null
}

/**
 * Extracts joined text from a list of Gemini parts. Thought (reasoning) parts
 * are excluded so model reasoning is not fed back as ordinary message content.
 */
function geminiPartsText(parts: Array<GeminiPart>): string {
  return parts
    .filter(
      (p): p is { text: string } =>
        typeof (p as { text?: unknown }).text === "string"
        && (p as { thought?: unknown }).thought !== true,
    )
    .map((p) => p.text)
    .join("")
}

/**
 * Converts Gemini content turns (plus systemInstruction) to internal messages.
 *
 * - systemInstruction -> system message
 * - role 'model' -> assistant; functionCall parts -> tool_calls
 * - role 'user' -> user; functionResponse parts -> tool result messages
 */
export function convertGeminiToMessages(
  request: GeminiRequest,
): Array<Message> {
  const messages: Array<Message> = []

  if (request.systemInstruction?.parts) {
    const systemText = geminiPartsText(request.systemInstruction.parts)
    if (systemText) {
      messages.push({ role: "system", content: systemText })
    }
  }

  for (const content of request.contents) {
    const parts = content.parts || []
    const textParts = geminiPartsText(parts)
    const functionCalls = parts.filter(
      (
        p,
      ): p is {
        functionCall: { name: string; args?: Record<string, unknown> }
      } => (p as { functionCall?: unknown }).functionCall !== undefined,
    )
    const functionResponses = parts.filter(
      (p): p is { functionResponse: { name: string; response: unknown } } =>
        (p as { functionResponse?: unknown }).functionResponse !== undefined,
    )

    if (content.role === "model") {
      const reasoning = geminiPartsReasoning(parts)
      const reasoningFields =
        reasoning ?
          {
            ...(reasoning.text ? { reasoning_text: reasoning.text } : {}),
            ...(reasoning.signature ?
              { reasoning_opaque: reasoning.signature }
            : {}),
          }
        : {}
      if (functionCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: textParts || null,
          ...reasoningFields,
          tool_calls: functionCalls.map((fc) => ({
            id: geminiToolCallId(fc.functionCall.name),
            type: "function" as const,
            function: {
              name: fc.functionCall.name,
              arguments: JSON.stringify(fc.functionCall.args ?? {}),
            },
          })),
        })
      } else {
        messages.push({
          role: "assistant",
          content: textParts,
          ...reasoningFields,
        })
      }
    } else if (functionResponses.length > 0) {
      for (const fr of functionResponses) {
        const value = fr.functionResponse.response
        const resultText =
          typeof value === "string" ? value : JSON.stringify(value ?? {})
        messages.push({
          role: "tool",
          content: resultText,
          tool_call_id: geminiToolCallId(fr.functionResponse.name),
          name: fr.functionResponse.name,
        })
      }
      if (textParts) {
        messages.push({ role: "user", content: textParts })
      }
    } else {
      messages.push({ role: "user", content: textParts })
    }
  }

  return messages
}

/**
 * Recursively converts a Gemini `Schema` into standard JSON Schema so Copilot's
 * chat-completions API accepts tool parameters.
 *
 * The google-genai SDK emits schema `type` values as uppercase enums
 * (`OBJECT`, `STRING`, `ARRAY`, …). Copilot expects lowercase JSON Schema types
 * (`object`, `string`, `array`, …); forwarding the uppercase form verbatim
 * makes Copilot reject the request with a 400 "invalid request body". This
 * lowercases every `type` and recurses through nested `properties`, `items`,
 * and combinator (`anyOf`/`allOf`/`oneOf`) subschemas. Property names are never
 * treated as schema keywords, so a property literally named `type` is preserved.
 */
export function normalizeGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => normalizeGeminiSchema(entry))
  }
  if (!schema || typeof schema !== "object") {
    return schema
  }
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(
    schema as Record<string, unknown>,
  )) {
    if (key === "type" && typeof value === "string") {
      result[key] = value.toLowerCase()
    } else if (
      key === "properties"
      && value
      && typeof value === "object"
      && !Array.isArray(value)
    ) {
      const props: Record<string, unknown> = {}
      for (const [propName, propSchema] of Object.entries(
        value as Record<string, unknown>,
      )) {
        props[propName] = normalizeGeminiSchema(propSchema)
      }
      result[key] = props
    } else if (
      key === "items"
      || key === "anyOf"
      || key === "allOf"
      || key === "oneOf"
    ) {
      result[key] = normalizeGeminiSchema(value)
    } else {
      result[key] = value
    }
  }
  return result
}

/**
 * Ensures a tool parameter schema is a valid JSON Schema object. Copilot's
 * chat/completions API rejects a function whose `parameters` is an empty `{}`
 * (or otherwise missing `type: "object"`) with a 400 "Bad Request". Gemini
 * function declarations frequently omit `parameters` for zero-argument tools,
 * so default those to an empty object schema.
 */
function ensureObjectSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    const record = schema as Record<string, unknown>
    if (typeof record.type === "string" && record.type.length > 0) {
      return record
    }
    return { type: "object", properties: {}, ...record }
  }
  return { type: "object", properties: {} }
}

/**
 * Converts Gemini tool declarations to the internal (OpenAI) tool format.
 */
export function convertGeminiTools(tools: Array<GeminiTool>): Array<Tool> {
  const result: Array<Tool> = []
  for (const tool of tools) {
    for (const decl of tool.functionDeclarations ?? []) {
      result.push({
        type: "function",
        function: {
          name: decl.name,
          description: decl.description,
          parameters: ensureObjectSchema(
            normalizeGeminiSchema(decl.parameters ?? {}),
          ),
        },
      })
    }
  }
  return result
}

/**
 * Converts a Gemini generateContent request to the internal OpenAI
 * chat-completions payload.
 */
export function convertGeminiToChatPayload(
  request: GeminiRequest,
  model: string,
  stream: boolean,
): ChatCompletionsPayload {
  const payload: ChatCompletionsPayload = {
    model,
    messages: convertGeminiToMessages(request),
    stream,
  }

  if (request.tools && request.tools.length > 0) {
    const tools = convertGeminiTools(request.tools)
    if (tools.length > 0) {
      payload.tools = tools
    }
  }

  const mode = request.toolConfig?.functionCallingConfig?.mode
  if (mode === "ANY") {
    payload.tool_choice = "required"
  } else if (mode === "NONE") {
    payload.tool_choice = "none"
  } else if (mode === "AUTO") {
    payload.tool_choice = "auto"
  }

  const config = request.generationConfig
  if (config) {
    if (config.temperature !== undefined)
      payload.temperature = config.temperature
    if (config.topP !== undefined) payload.top_p = config.topP
    // Note: Gemini's `topK` is intentionally not forwarded. Copilot's
    // chat/completions endpoint rejects `top_k` with a 400 "Bad Request",
    // and Gemini SDKs send a default `topK`, which would break every request.
    if (config.maxOutputTokens !== undefined) {
      payload.max_tokens = config.maxOutputTokens
    }
    if (config.stopSequences && config.stopSequences.length > 0) {
      payload.stop = config.stopSequences
    }
  }

  return payload
}

/**
 * Maps an OpenAI finish reason to a Gemini finish reason.
 */
export function mapFinishReason(
  reason: string | null | undefined,
): GeminiFinishReason {
  switch (reason) {
    case "length": {
      return "MAX_TOKENS"
    }
    case "content_filter": {
      return "SAFETY"
    }
    // "stop", "tool_calls" and unknown values map to STOP.
    default: {
      return "STOP"
    }
  }
}

/**
 * Builds the model output parts for a Gemini candidate from reasoning + text +
 * tool calls. Reasoning (if any) is emitted first as a `thought` part, matching
 * Gemini's native ordering. Always returns at least one part so candidates are
 * never empty (an empty candidate is surfaced by clients as "no response").
 */
export function buildGeminiParts(
  content: string | null | undefined,
  toolCalls?: Array<ToolCall>,
  reasoning?: GeminiReasoning,
): Array<GeminiPart> {
  const parts: Array<GeminiPart> = []
  if (reasoning && (reasoning.text || reasoning.signature)) {
    parts.push({
      // A signature-only thought must still carry non-empty text so downstream
      // clients don't build a reasoning block without a text field.
      text: reasoning.text || GEMINI_THINKING_TEXT,
      thought: true,
      ...(reasoning.signature ? { thoughtSignature: reasoning.signature } : {}),
    })
  }
  if (content) {
    parts.push({ text: content })
  }
  if (toolCalls && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(tc.function.arguments) as Record<string, unknown>
      } catch {
        // keep empty on malformed argument JSON
      }
      parts.push({ functionCall: { name: tc.function.name, args } })
    }
  }
  if (parts.length === 0) {
    parts.push({ text: "" })
  }
  return parts
}

function toGeminiUsage(
  usage: ChatCompletionResponse["usage"],
): GeminiUsageMetadata | undefined {
  if (!usage) return undefined
  return {
    promptTokenCount: usage.prompt_tokens,
    candidatesTokenCount: usage.completion_tokens,
    totalTokenCount: usage.total_tokens,
  }
}

/**
 * Converts a non-streaming OpenAI chat-completions response to a Gemini
 * generateContent response.
 */
export function chatResponseToGemini(
  response: ChatCompletionResponse,
  model: string,
  responseId: string,
): GeminiResponse {
  const choice = response.choices[0]
  const message = choice?.message
  const reasoning: GeminiReasoning = {
    text: message?.reasoning_text ?? message?.reasoning_content,
    signature: message?.reasoning_opaque,
  }
  const parts = buildGeminiParts(
    message?.content,
    message?.tool_calls,
    reasoning,
  )

  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason: mapFinishReason(choice?.finish_reason),
        index: 0,
      },
    ],
    usageMetadata: toGeminiUsage(response.usage),
    modelVersion: model,
    responseId,
  }
}

/**
 * Creates a single Gemini streaming chunk (a partial GenerateContentResponse).
 */
export function createGeminiStreamChunk(
  parts: Array<GeminiPart>,
  options: {
    model?: string
    responseId?: string
    finishReason?: GeminiFinishReason
    usage?: GeminiUsageMetadata
  } = {},
): GeminiResponse {
  const chunk: GeminiResponse = {
    candidates: [
      {
        content: { role: "model", parts },
        index: 0,
        ...(options.finishReason ? { finishReason: options.finishReason } : {}),
      },
    ],
  }
  if (options.usage) chunk.usageMetadata = options.usage
  if (options.model) chunk.modelVersion = options.model
  if (options.responseId) chunk.responseId = options.responseId
  return chunk
}

/**
 * Creates a Gemini error response (matches Google's { error: {...} } shape).
 */
export function createGeminiErrorResponse(
  code: number,
  message: string,
  status: string,
): GeminiErrorResponse {
  return { error: { code, message, status } }
}
