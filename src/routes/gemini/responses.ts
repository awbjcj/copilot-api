import type { ChatCompletionsPayload } from "~/lib/types/chat-completions"
import type {
  ResponseInputItem,
  ResponsesPayload,
  ResponsesResult,
} from "~/lib/types/responses"
import type { GeminiPart, GeminiResponse } from "./gemini-types"
import { GeminiError } from "./errors"
import { buildGeminiParts } from "./translation"

/** Translate the supported chat-shaped request without routing every model through chat. */
export function toResponsesPayload(
  chat: ChatCompletionsPayload,
): ResponsesPayload {
  const input: Array<ResponseInputItem> = []
  for (const message of chat.messages) {
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id!,
        output:
          typeof message.content === "string" ?
            message.content
          : JSON.stringify(message.content),
      })
      continue
    }
    if (message.reasoning_opaque) {
      input.push({
        type: "reasoning",
        encrypted_content: message.reasoning_opaque,
        summary:
          message.reasoning_text ?
            [{ type: "summary_text", text: message.reasoning_text }]
          : [],
      })
    }
    if (message.content) {
      input.push({
        type: "message",
        role: message.role,
        content:
          typeof message.content === "string" ?
            message.content
          : message.content.map((part) => {
              if (part.type === "text")
                return { type: "input_text" as const, text: part.text }
              if (part.type === "image_url")
                return {
                  type: "input_image" as const,
                  image_url: part.image_url.url,
                  detail: "auto" as const,
                }
              return {
                type: "input_file" as const,
                file_data: part.file.file_data,
                filename: part.file.filename,
              }
            }),
      })
    }
    for (const call of message.tool_calls ?? [])
      input.push({
        type: "function_call",
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })
  }
  const format = chat.response_format
  return {
    model: chat.model,
    input,
    stream: chat.stream,
    store: false,
    include: ["reasoning.encrypted_content"],
    max_output_tokens: chat.max_completion_tokens ?? chat.max_tokens,
    ...(chat.temperature !== undefined ?
      { temperature: chat.temperature }
    : {}),
    ...(chat.top_p !== undefined ? { top_p: chat.top_p } : {}),
    ...(chat.tools?.length ?
      {
        tools: chat.tools.map((tool) => ({
          type: "function",
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
          strict: false,
        })),
        tool_choice:
          typeof chat.tool_choice === "object" && chat.tool_choice ?
            { type: "function", name: chat.tool_choice.function.name }
          : (chat.tool_choice ?? "auto"),
      }
    : {}),
    ...(chat.reasoning_effort ?
      {
        reasoning: {
          effort: chat.reasoning_effort as NonNullable<
            ResponsesPayload["reasoning"]
          >["effort"],
          summary: "auto",
        },
      }
    : {}),
    ...(format ?
      {
        text: {
          format:
            format.type === "json_schema" ?
              { type: "json_schema", ...format.json_schema }
            : format,
        },
      }
    : {}),
  }
}

/** Convert a completed native or Messages-backed Responses result. */
export function responsesResultToGemini(
  result: ResponsesResult,
): GeminiResponse {
  if (result.status === "failed" || result.error)
    throw new GeminiError(
      result.error?.message ?? "Upstream generation failed",
      502,
    )
  if (!Array.isArray(result.output))
    throw new GeminiError("Invalid upstream Responses result", 502)
  const parts: Array<GeminiPart> = []
  for (const item of result.output) {
    if (item.type === "message") {
      for (const content of item.content ?? []) {
        if (content.type === "output_text" && typeof content.text === "string")
          parts.push({ text: content.text })
        else if (
          content.type === "refusal"
          && typeof content.refusal === "string"
        )
          parts.push({ text: content.refusal })
      }
    } else if (item.type === "function_call") {
      parts.push(
        ...buildGeminiParts(null, [
          {
            id: item.call_id,
            type: "function",
            function: { name: item.name, arguments: item.arguments },
          },
        ]),
      )
    } else if (item.type === "reasoning") {
      parts.push(
        ...buildGeminiParts(null, undefined, {
          text: item.summary?.map((s) => s.text).join(""),
          signature: item.encrypted_content,
        }),
      )
    } else {
      throw new GeminiError(`Unsupported upstream output: ${item.type}`, 502)
    }
  }
  const usage = result.usage
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: parts.length ? parts : [{ text: "" }],
        },
        index: 0,
        finishReason:
          result.incomplete_details?.reason === "content_filter" ? "SAFETY"
          : result.status === "incomplete" ? "MAX_TOKENS"
          : "STOP",
      },
    ],
    modelVersion: result.model,
    responseId: result.id,
    ...(usage ?
      {
        usageMetadata: {
          promptTokenCount: usage.input_tokens,
          candidatesTokenCount: usage.output_tokens ?? 0,
          totalTokenCount: usage.total_tokens,
          cachedContentTokenCount: usage.input_tokens_details?.cached_tokens,
          thoughtsTokenCount: usage.output_tokens_details?.reasoning_tokens,
        },
      }
    : {}),
  }
}
