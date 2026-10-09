import { expect, test } from "bun:test"

import type { AnthropicResponse } from "~/lib/types/anthropic"
import type { ResponsesTextConfig } from "~/lib/types/responses"
import {
  translateAnthropicToResponses,
  translateResponsesToMessages,
} from "~/routes/responses/messages-translation"
import {
  responsesResultToStreamEvents,
  translateMessagesStream,
} from "~/routes/responses/messages-stream-translation"

const schemaFormat: ResponsesTextConfig = {
  format: {
    type: "json_schema",
    name: "Answer",
    strict: true,
    schema: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    },
  },
  verbosity: "low",
}

const upstream: AnthropicResponse = {
  id: "msg_schema",
  type: "message",
  role: "assistant",
  model: "gemini-3.8-flash",
  content: [{ type: "text", text: '{"ok":true}' }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 8, output_tokens: 4 },
}

test.each([
  schemaFormat,
  { format: { type: "json_object" } },
  { format: { type: "text" }, verbosity: "low" },
] satisfies Array<ResponsesTextConfig>)(
  "preserves output format in JSON and synthesized SSE responses: %j",
  (text) => {
    const context = translateResponsesToMessages(
      { model: upstream.model, input: "Return ok true", text },
      { model: upstream.model },
    )
    const response = translateAnthropicToResponses(upstream, context)
    expect(response).toMatchObject({ text, output_text: '{"ok":true}' })
    const lifecycle = responsesResultToStreamEvents(response).filter(
      (event) => "response" in event,
    )
    expect(lifecycle.map((event) => event.type)).toContain("response.completed")
    for (const event of lifecycle) {
      expect(event).toMatchObject({ response: { text } })
    }
    expect(lifecycle.at(-1)).toMatchObject({
      response: {
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: '{"ok":true}' }],
          },
        ],
      },
    })
  },
)

test.each([
  { stopReason: "end_turn", terminalType: "response.completed" },
  { stopReason: "max_tokens", terminalType: "response.incomplete" },
] as const)(
  "preserves structured stream output on %j",
  async ({ stopReason, terminalType }) => {
    const context = translateResponsesToMessages(
      { model: upstream.model, input: "Return ok true", text: schemaFormat },
      { model: upstream.model },
    )
    const source = [
      {
        type: "message_start",
        message: { ...upstream, content: [], stop_reason: null },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: '{"ok":true}' },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 4 },
      },
      { type: "message_stop" },
    ]
    async function* chunks() {
      await Promise.resolve()
      for (const event of source) yield { data: JSON.stringify(event) }
    }

    const lifecycle = []
    for await (const event of translateMessagesStream(chunks(), context)) {
      if ("response" in event) lifecycle.push(event)
    }
    expect(lifecycle.map((event) => event.type)).toEqual([
      "response.created",
      "response.in_progress",
      terminalType,
    ])
    for (const event of lifecycle) {
      expect(event.response).toMatchObject({ text: schemaFormat })
    }
    expect(lifecycle.at(-1)?.response.output_text).toBe('{"ok":true}')
    expect(lifecycle.at(-1)?.response.output).toMatchObject([
      {
        type: "message",
        status: "completed",
        content: [{ type: "output_text", text: '{"ok":true}' }],
      },
    ])
  },
)
