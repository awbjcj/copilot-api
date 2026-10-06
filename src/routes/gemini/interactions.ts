import { randomUUID } from "node:crypto"
import type { Context } from "hono"
import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"
import { writeSSEIfConnected } from "~/lib/sse"
import type {
  GeminiContent,
  GeminiPart,
  GeminiRequest,
  GeminiResponse,
} from "./gemini-types"
import { GeminiError, geminiErrorBody } from "./errors"
import { generateGemini } from "./handler"
import { isRecord } from "./validation"

export const interactionDependencies = { generateGemini }

/** Decode only stateless model interactions; no request is implicitly stored. */
export function interactionToGemini(value: unknown): {
  model: string
  stream: boolean
  request: GeminiRequest
} {
  if (!isRecord(value)) throw new GeminiError("Interaction must be an object")
  if (value.store !== false)
    throw new GeminiError(
      "Only stateless interactions are supported; set store=false",
    )
  if (
    value.previous_interaction_id !== undefined
    || value.background === true
    || value.agent !== undefined
  )
    throw new GeminiError(
      "Stored history, background execution and hosted agents are not supported",
      501,
    )
  for (const key of Object.keys(value))
    if (
      ![
        "model",
        "input",
        "store",
        "stream",
        "background",
        "tools",
        "system_instruction",
        "generation_config",
        "response_format",
      ].includes(key)
    )
      throw new GeminiError(`Unsupported interaction field: ${key}`)
  if (typeof value.model !== "string" || !value.model.trim())
    throw new GeminiError("model is required")
  if (value.stream !== undefined && typeof value.stream !== "boolean")
    throw new GeminiError("stream must be a boolean")
  if (value.background !== undefined && value.background !== false)
    throw new GeminiError("background must be false")
  const contents: GeminiContent[] = []
  if (typeof value.input === "string")
    contents.push({ role: "user", parts: [{ text: value.input }] })
  else if (Array.isArray(value.input)) {
    for (const step of value.input) {
      if (!isRecord(step))
        throw new GeminiError("Interaction input steps must be objects")
      if (step.type === "user_input" || step.type === "model_output") {
        if (!Array.isArray(step.content))
          throw new GeminiError("Input/output steps require a content array")
        contents.push({
          role: step.type === "user_input" ? "user" : "model",
          parts: step.content.map(interactionPart),
        })
      } else if (step.type === "function_call") {
        if (
          typeof step.id !== "string"
          || typeof step.name !== "string"
          || !isRecord(step.arguments)
        )
          throw new GeminiError(
            "function_call requires id, name and object arguments",
          )
        appendModelParts(contents, [
          {
            functionCall: {
              id: step.id,
              name: step.name,
              args: step.arguments,
            },
          },
        ])
      } else if (step.type === "function_result") {
        if (
          typeof step.call_id !== "string"
          || typeof step.name !== "string"
          || !Array.isArray(step.result)
        )
          throw new GeminiError(
            "function_result requires call_id, name and a result array",
          )
        const output = step.result
          .map((part) => {
            if (
              !isRecord(part)
              || part.type !== "text"
              || typeof part.text !== "string"
            )
              throw new GeminiError("Only text function results are supported")
            return part.text
          })
          .join("")
        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                id: step.call_id,
                name: step.name,
                response: { output },
              },
            },
          ],
        })
      } else if (step.type === "thought") {
        if (typeof step.signature !== "string")
          throw new GeminiError("thought requires a signature")
        const summary = step.summary === undefined ? [] : step.summary
        if (!Array.isArray(summary))
          throw new GeminiError("thought summary must be an array")
        const text = summary
          .map((p) => {
            if (!isRecord(p) || p.type !== "text" || typeof p.text !== "string")
              throw new GeminiError("Only text thought summaries are supported")
            return p.text
          })
          .join("")
        appendModelParts(contents, [
          { text, thought: true, thoughtSignature: step.signature },
        ])
      } else
        throw new GeminiError(
          `Unsupported interaction input step: ${String(step.type)}`,
        )
    }
  } else throw new GeminiError("input must be a string or an array of steps")
  const request: GeminiRequest = { contents }
  if (value.system_instruction !== undefined) {
    if (typeof value.system_instruction !== "string")
      throw new GeminiError("system_instruction must be a string")
    request.systemInstruction = { parts: [{ text: value.system_instruction }] }
  }
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools))
      throw new GeminiError("tools must be an array")
    request.tools = [
      {
        functionDeclarations: value.tools.map((tool) => {
          if (
            !isRecord(tool)
            || tool.type !== "function"
            || typeof tool.name !== "string"
          )
            throw new GeminiError("Only function tools are supported")
          if (
            Object.keys(tool).some(
              (k) => !["type", "name", "description", "parameters"].includes(k),
            )
          )
            throw new GeminiError("Unsupported function tool field")
          if (tool.parameters !== undefined && !isRecord(tool.parameters))
            throw new GeminiError("Function parameters must be an object")
          return {
            name: tool.name,
            description:
              typeof tool.description === "string" ?
                tool.description
              : undefined,
            parametersJsonSchema: tool.parameters,
          }
        }),
      },
    ]
  }
  const config = value.generation_config
  if (config !== undefined) {
    if (!isRecord(config))
      throw new GeminiError("generation_config must be an object")
    const mapped: Record<string, unknown> = {}
    const fields: Record<string, string> = {
      temperature: "temperature",
      top_p: "topP",
      max_output_tokens: "maxOutputTokens",
      seed: "seed",
      stop_sequences: "stopSequences",
    }
    for (const [key, item] of Object.entries(config)) {
      if (fields[key]) mapped[fields[key]] = item
      else if (!["thinking_level", "thinking_summaries"].includes(key))
        throw new GeminiError(`Unsupported generation_config field: ${key}`)
    }
    const thinking: Record<string, unknown> = {}
    if (config.thinking_level !== undefined) {
      if (typeof config.thinking_level !== "string")
        throw new GeminiError("thinking_level must be a string")
      thinking.thinkingLevel = config.thinking_level.toUpperCase()
    }
    if (config.thinking_summaries !== undefined) {
      if (!["auto", "none"].includes(config.thinking_summaries as string))
        throw new GeminiError("thinking_summaries must be auto or none")
      thinking.includeThoughts = config.thinking_summaries === "auto"
    }
    if (Object.keys(thinking).length) mapped.thinkingConfig = thinking
    request.generationConfig = mapped
  }
  if (value.response_format !== undefined) {
    const format = value.response_format
    if (
      !isRecord(format)
      || format.type !== "text"
      || Object.keys(format).some(
        (k) => !["type", "mime_type", "schema"].includes(k),
      )
    )
      throw new GeminiError("Only text response_format is supported")
    request.generationConfig = {
      ...request.generationConfig,
      responseMimeType: format.mime_type as string,
      responseJsonSchema: format.schema as Record<string, unknown> | undefined,
    }
  }
  return {
    model: value.model.replace(/^models\//u, ""),
    stream: value.stream === true,
    request,
  }
}

function appendModelParts(contents: GeminiContent[], parts: GeminiPart[]) {
  const last = contents.at(-1)
  if (last?.role === "model") last.parts.push(...parts)
  else contents.push({ role: "model", parts })
}

function interactionPart(part: unknown): GeminiPart {
  if (!isRecord(part)) throw new GeminiError("Content must contain objects")
  if (part.type === "text" && typeof part.text === "string")
    return { text: part.text }
  if (
    part.type === "image"
    && typeof part.data === "string"
    && typeof part.mime_type === "string"
  )
    return { inlineData: { data: part.data, mimeType: part.mime_type } }
  throw new GeminiError("Only text and inline image content are supported")
}

export type InteractionStep =
  | {
      type: "model_output"
      id: string
      content: Array<{ type: "text"; text: string }>
    }
  | {
      type: "thought"
      id: string
      signature: string
      summary: Array<{ type: "text"; text: string }>
    }
  | {
      type: "function_call"
      id: string
      name: string
      arguments: Record<string, unknown>
    }

/** Translate output into the current flat steps schema, retaining opaque state. */
export function geminiToInteractionSteps(
  response: GeminiResponse,
): InteractionStep[] {
  return (response.candidates[0]?.content.parts ?? []).flatMap(
    (part): InteractionStep[] => {
      if ("functionCall" in part)
        return [
          {
            type: "function_call",
            id: part.functionCall.id ?? randomUUID(),
            name: part.functionCall.name,
            arguments: part.functionCall.args ?? {},
          },
        ]
      if ("text" in part && (part.thought || part.thoughtSignature))
        return [
          {
            type: "thought",
            id: randomUUID(),
            signature: part.thoughtSignature ?? "",
            summary: part.text ? [{ type: "text", text: part.text }] : [],
          },
        ]
      if ("text" in part && part.text)
        return [
          {
            type: "model_output",
            id: randomUUID(),
            content: [{ type: "text", text: part.text }],
          },
        ]
      return []
    },
  )
}

function interactionResult(
  id: string,
  steps: InteractionStep[],
  response: GeminiResponse,
  model: string,
) {
  const usage = response.usageMetadata
  return {
    id,
    object: "interaction",
    model,
    status:
      response.candidates[0]?.finishReason === "MAX_TOKENS" ? "incomplete"
      : steps.some((step) => step.type === "function_call") ? "requires_action"
      : "completed",
    steps,
    output_text: steps
      .flatMap((s) =>
        s.type === "model_output" ? s.content.map((p) => p.text) : [],
      )
      .join(""),
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    usage:
      usage ?
        {
          total_input_tokens: usage.promptTokenCount,
          total_output_tokens: usage.candidatesTokenCount,
          total_tokens: usage.totalTokenCount,
          total_cached_tokens: usage.cachedContentTokenCount,
          total_thought_tokens: usage.thoughtsTokenCount,
        }
      : undefined,
  }
}

/** Serve stateless Interactions with native step events and explicit unsupported-state errors. */
export async function handleInteraction(c: Context): Promise<Response> {
  const { request, model, stream } = interactionToGemini(await c.req.json())
  const response = await interactionDependencies.generateGemini(
    c,
    request,
    model,
    stream,
  )
  const id = `interaction_${randomUUID()}`
  if (!stream) {
    const result = (await response.json()) as GeminiResponse
    return c.json(
      interactionResult(id, geminiToInteractionSteps(result), result, model),
    )
  }
  return streamSSE(c, async (sse) => {
    const steps: InteractionStep[] = []
    let final: GeminiResponse = { candidates: [] }
    const emit = async (type: string, data: Record<string, unknown>) =>
      writeSSEIfConnected(sse, {
        event: type,
        data: JSON.stringify({ event_type: type, ...data }),
      })
    await emit("interaction.created", {
      interaction: { id, object: "interaction", model, status: "in_progress" },
    })
    try {
      for await (const event of events(response)) {
        if (!event.data) continue
        const chunk = JSON.parse(event.data) as GeminiResponse & {
          error?: { message: string }
        }
        if (chunk.error) throw new GeminiError(chunk.error.message, 502)
        final = chunk
        for (const step of geminiToInteractionSteps(chunk)) {
          const index = steps.length
          steps.push(step)
          if (
            !(await emit("step.start", {
              index,
              step:
                step.type === "model_output" ? { ...step, content: [] } : step,
            }))
          )
            return
          if (step.type === "model_output")
            await emit("step.delta", {
              index,
              delta: {
                type: "text",
                text: step.content.map((p) => p.text).join(""),
              },
            })
          await emit("step.stop", { index })
        }
      }
      if (!final.candidates[0]?.finishReason)
        throw new GeminiError("Generation ended before completion", 502)
      await emit("interaction.completed", {
        interaction: interactionResult(id, steps, final, model),
      })
    } catch (error) {
      await emit("error", await geminiErrorBody(error))
    }
  })
}
