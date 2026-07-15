import { describe, expect, test } from "bun:test"

import type { ChatCompletionResponse } from "../src/services/copilot/create-chat-completions"

import type { GeminiRequest } from "../src/routes/gemini/gemini-types"
import {
  chatResponseToGemini,
  convertGeminiToChatPayload,
  convertGeminiToMessages,
  convertGeminiTools,
  createGeminiStreamChunk,
  geminiToolCallId,
  mapFinishReason,
  validateGeminiRequest,
} from "../src/routes/gemini/translation"

describe("validateGeminiRequest", () => {
  test("rejects missing contents", () => {
    expect(validateGeminiRequest({} as GeminiRequest)).toBe(
      "contents is required and must be an array",
    )
  })

  test("rejects empty contents", () => {
    expect(validateGeminiRequest({ contents: [] })).toBe(
      "contents array cannot be empty",
    )
  })

  test("rejects invalid role", () => {
    expect(
      validateGeminiRequest({
        contents: [{ role: "assistant" as never, parts: [{ text: "hi" }] }],
      }),
    ).toBe("contents[0].role must be 'user' or 'model'")
  })

  test("accepts a valid request", () => {
    expect(
      validateGeminiRequest({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
      }),
    ).toBeNull()
  })
})

describe("convertGeminiToMessages", () => {
  test("maps system instruction, user and model turns", () => {
    const messages = convertGeminiToMessages({
      systemInstruction: { parts: [{ text: "be brief" }] },
      contents: [
        { role: "user", parts: [{ text: "hello" }] },
        { role: "model", parts: [{ text: "hi there" }] },
      ],
    })

    expect(messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ])
  })

  test("maps model function calls to tool_calls", () => {
    const messages = convertGeminiToMessages({
      contents: [
        {
          role: "model",
          parts: [
            { functionCall: { name: "get_weather", args: { city: "NYC" } } },
          ],
        },
      ],
    })

    expect(messages[0]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: geminiToolCallId("get_weather"),
          type: "function",
          function: {
            name: "get_weather",
            arguments: JSON.stringify({ city: "NYC" }),
          },
        },
      ],
    })
  })

  test("maps function responses to tool messages", () => {
    const messages = convertGeminiToMessages({
      contents: [
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "get_weather",
                response: { temp: 20 },
              },
            },
          ],
        },
      ],
    })

    expect(messages[0]).toEqual({
      role: "tool",
      content: JSON.stringify({ temp: 20 }),
      tool_call_id: geminiToolCallId("get_weather"),
      name: "get_weather",
    })
  })
})

describe("convertGeminiTools", () => {
  test("flattens function declarations into OpenAI tools", () => {
    const tools = convertGeminiTools([
      {
        functionDeclarations: [
          {
            name: "get_weather",
            description: "Get weather",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    ])

    expect(tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: {} },
        },
      },
    ])
  })

  test("defaults missing parameters to a valid object schema", () => {
    const tools = convertGeminiTools([
      {
        functionDeclarations: [
          { name: "list_prefs", description: "list prefs" },
        ],
      },
    ])

    // Copilot rejects a function whose parameters is an empty `{}`; the
    // translation must emit a valid `{ type: "object" }` schema instead.
    expect(tools[0].function.parameters).toEqual({
      type: "object",
      properties: {},
    })
  })

  test("lowercases uppercase Gemini schema types recursively", () => {
    const tools = convertGeminiTools([
      {
        functionDeclarations: [
          {
            name: "get_weather",
            description: "Get weather",
            parameters: {
              type: "OBJECT",
              properties: {
                city: { type: "STRING", description: "city name" },
                days: {
                  type: "ARRAY",
                  items: { type: "INTEGER" },
                },
                type: { type: "STRING", description: "a field named type" },
              },
              required: ["city"],
            },
          },
        ],
      },
    ])

    expect(tools[0].function.parameters).toEqual({
      type: "object",
      properties: {
        city: { type: "string", description: "city name" },
        days: {
          type: "array",
          items: { type: "integer" },
        },
        type: { type: "string", description: "a field named type" },
      },
      required: ["city"],
    })
  })
})

describe("convertGeminiToChatPayload", () => {
  test("maps generationConfig and toolConfig", () => {
    const payload = convertGeminiToChatPayload(
      {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: [{ functionDeclarations: [{ name: "t", parameters: {} }] }],
        toolConfig: { functionCallingConfig: { mode: "ANY" } },
        generationConfig: {
          temperature: 0.5,
          topP: 0.9,
          maxOutputTokens: 256,
          stopSequences: ["END"],
        },
      },
      "gemini-2.5-pro",
      true,
    )

    expect(payload.model).toBe("gemini-2.5-pro")
    expect(payload.stream).toBe(true)
    expect(payload.temperature).toBe(0.5)
    expect(payload.top_p).toBe(0.9)
    expect(payload.max_tokens).toBe(256)
    expect(payload.stop).toEqual(["END"])
    expect(payload.tool_choice).toBe("required")
    expect(payload.tools).toHaveLength(1)
  })

  test("does not forward topK (Copilot rejects top_k)", () => {
    const payload = convertGeminiToChatPayload(
      {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: {
          topK: 40,
        },
      },
      "gemini-2.5-pro",
      false,
    )

    expect(payload.top_k).toBeUndefined()
  })
})

describe("mapFinishReason", () => {
  test("maps OpenAI finish reasons", () => {
    expect(mapFinishReason("stop")).toBe("STOP")
    expect(mapFinishReason("tool_calls")).toBe("STOP")
    expect(mapFinishReason("length")).toBe("MAX_TOKENS")
    expect(mapFinishReason("content_filter")).toBe("SAFETY")
    expect(mapFinishReason(null)).toBe("STOP")
  })
})

describe("chatResponseToGemini", () => {
  test("converts a text response", () => {
    const response: ChatCompletionResponse = {
      id: "id",
      object: "chat.completion",
      created: 0,
      model: "gemini-2.5-pro",
      choices: [
        {
          index: 0,
          logprobs: null,
          finish_reason: "stop",
          message: { role: "assistant", content: "hello world" },
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }

    const gemini = chatResponseToGemini(response, "gemini-2.5-pro", "resp-1")

    expect(gemini.candidates[0].content.parts).toEqual([
      { text: "hello world" },
    ])
    expect(gemini.candidates[0].finishReason).toBe("STOP")
    expect(gemini.usageMetadata).toEqual({
      promptTokenCount: 5,
      candidatesTokenCount: 2,
      totalTokenCount: 7,
    })
    expect(gemini.responseId).toBe("resp-1")
  })

  test("converts a tool-call response", () => {
    const response: ChatCompletionResponse = {
      id: "id",
      object: "chat.completion",
      created: 0,
      model: "gemini-2.5-pro",
      choices: [
        {
          index: 0,
          logprobs: null,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: JSON.stringify({ city: "NYC" }),
                },
              },
            ],
          },
        },
      ],
    }

    const gemini = chatResponseToGemini(response, "gemini-2.5-pro", "resp-2")

    expect(gemini.candidates[0].content.parts).toEqual([
      { functionCall: { name: "get_weather", args: { city: "NYC" } } },
    ])
  })
})

describe("createGeminiStreamChunk", () => {
  test("includes finishReason and usage on the final chunk", () => {
    const chunk = createGeminiStreamChunk([{ text: "" }], {
      model: "gemini-2.5-pro",
      responseId: "r",
      finishReason: "STOP",
      usage: {
        promptTokenCount: 1,
        candidatesTokenCount: 2,
        totalTokenCount: 3,
      },
    })

    expect(chunk.candidates[0].finishReason).toBe("STOP")
    expect(chunk.usageMetadata?.totalTokenCount).toBe(3)
    expect(chunk.modelVersion).toBe("gemini-2.5-pro")
  })
})
