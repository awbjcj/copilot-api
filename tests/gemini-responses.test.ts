import { describe, expect, test } from "bun:test"

import type { AnthropicResponse } from "~/lib/types/anthropic"
import type { ResponseInputItem, ResponsesPayload } from "~/lib/types/responses"
import {
  ResponsesMessagesTranslationError,
  translateAnthropicToResponses,
  translateResponsesToMessages,
} from "~/routes/responses/messages-translation"
import { responsesResultToStreamEvents } from "~/routes/responses/messages-stream-translation"

describe("Gemini Responses empty text history", () => {
  const translate = (input: Array<ResponseInputItem>) =>
    translateResponsesToMessages(
      { model: "gemini-3.8-flash", input },
      { model: "gemini-3.8-flash" },
    ).messagesPayload

  test("drops LangChain's empty assistant output before replaying signed tools", () => {
    const payload = translate([
      { role: "user", content: "Call echo" },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "", annotations: [] }],
      },
      {
        type: "reasoning",
        id: "rs-test",
        summary: [],
        encrypted_content: "signature-test",
      },
      {
        type: "function_call",
        call_id: "call-test",
        name: "echo",
        arguments: '{"value":"ok"}',
      },
      {
        type: "function_call_output",
        call_id: "call-test",
        output: "ok",
      },
    ])
    expect(payload.messages).toHaveLength(3)
    expect(payload.messages[1].content).toEqual([
      { type: "thinking", thinking: "", signature: "signature-test" },
      {
        type: "tool_use",
        id: "call-test",
        name: "echo",
        input: { value: "ok" },
      },
    ])
  })

  test("drops empty text while preserving system, developer and assistant text", () => {
    const payload = translate([
      {
        role: "developer",
        content: [
          { type: "input_text", text: "" },
          { type: "input_text", text: "Developer prompt" },
        ],
      },
      {
        role: "system",
        content: [
          { type: "input_text", text: "" },
          { type: "input_text", text: "System prompt" },
        ],
      },
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [
          { type: "output_text", text: "", annotations: [] },
          { type: "output_text", text: "Previous answer", annotations: [] },
        ],
      },
      { role: "user", content: "Continue" },
    ])
    expect(payload.system).toMatchObject([
      { type: "text", text: "Developer prompt" },
      { type: "text", text: "System prompt" },
    ])
    expect(payload.messages[1].content).toEqual([
      { type: "text", text: "Previous answer" },
    ])
  })

  test("drops empty user text without dropping images or PDF attachments", () => {
    const payload = translate([
      {
        role: "user",
        content: [
          { type: "input_text", text: "" },
          { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
          {
            type: "input_file",
            file_data: "data:application/pdf;base64,cGRm",
            filename: "test.pdf",
          },
          { type: "input_text", text: "Read the attachments" },
        ],
      },
    ])
    expect(payload.messages[0].content).toMatchObject([
      { type: "image", source: { data: "aW1hZ2U=" } },
      { type: "document", source: { data: "cGRm" } },
      { type: "text", text: "Read the attachments" },
    ])
  })

  test.each(["user", "assistant", "system", "developer"] as const)(
    "still rejects a missing text field in a %s message",
    (role) => {
      const malformed = {
        role,
        content: [
          { type: role === "assistant" ? "output_text" : "input_text" },
        ],
      } as unknown as ResponseInputItem
      expect(() =>
        translate([malformed, { role: "user", content: "Hello" }]),
      ).toThrow(ResponsesMessagesTranslationError)
    },
  )
})

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
