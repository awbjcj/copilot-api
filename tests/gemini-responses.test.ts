import { expect, test } from "bun:test"

import type { AnthropicResponse } from "~/lib/types/anthropic"
import type { ResponsesPayload } from "~/lib/types/responses"
import {
  translateAnthropicToResponses,
  translateResponsesToMessages,
} from "~/routes/responses/messages-translation"
import { responsesResultToStreamEvents } from "~/routes/responses/messages-stream-translation"

test("shared Gemini transport preserves media, multiple signatures and inclusive usage", () => {
  const payload: ResponsesPayload = {
    model: "gemini-3.5-flash",
    reasoning: { effort: "medium" },
    max_output_tokens: 512,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Read these files" },
          { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
          {
            type: "input_file",
            file_data: "data:application/pdf;base64,cGRm",
            filename: "test.pdf",
          },
        ],
      },
    ],
    tools: [
      {
        type: "function",
        name: "echo",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
        },
        strict: false,
      },
    ],
  }
  const translation = translateResponsesToMessages(payload, {
    model: payload.model,
  })
  expect(translation.messagesPayload.output_config?.effort).toBe("medium")
  expect(translation.messagesPayload.max_tokens).toBe(512)
  expect(translation.messagesPayload.messages[0].content).toMatchObject([
    { type: "text", text: "Read these files" },
    { type: "image", source: { media_type: "image/png", data: "aW1hZ2U=" } },
    {
      type: "document",
      source: { media_type: "application/pdf", data: "cGRm" },
    },
  ])
  const upstream: AnthropicResponse = {
    id: "message_test",
    type: "message",
    role: "assistant",
    model: payload.model,
    content: [
      { type: "thinking", thinking: "first", signature: "signature-a" },
      { type: "thinking", thinking: "second", signature: "signature-b" },
      {
        type: "tool_use",
        id: "call_test",
        name: "echo",
        input: { value: "ok" },
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 8, cache_read_input_tokens: 2, output_tokens: 7 },
  }
  const response = translateAnthropicToResponses(upstream, translation)
  expect(response.usage).toMatchObject({
    input_tokens: 10,
    output_tokens: 7,
    total_tokens: 17,
    input_tokens_details: { cached_tokens: 2 },
  })
  const events = responsesResultToStreamEvents(response)
  expect(
    events.filter(
      (event) => event.type === "response.reasoning_summary_text.delta",
    ),
  ).toHaveLength(2)
  const replay = translateResponsesToMessages(
    {
      ...payload,
      input: [
        ...(payload.input as NonNullable<
          Exclude<ResponsesPayload["input"], string>
        >),
        ...response.output
          .filter(
            (item) =>
              item.type === "reasoning" || item.type === "function_call",
          )
          .map((item) =>
            item.type === "reasoning" ?
              { ...item, summary: item.summary ?? [] }
            : item,
          ),
        { type: "function_call_output", call_id: "call_test", output: "ok" },
      ],
    },
    { model: payload.model },
  )
  expect(replay.messagesPayload.messages[1].content).toMatchObject([
    { type: "thinking", thinking: "first", signature: "signature-a" },
    { type: "thinking", thinking: "second", signature: "signature-b" },
    { type: "tool_use", id: "call_test", name: "echo" },
  ])
})
