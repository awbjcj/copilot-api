import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { state } from "~/lib/state"
import { getConfig } from "~/lib/config"
import { createFallbackModel } from "~/lib/provider-model"
import { HTTPError, UpstreamHeadersTimeoutError } from "~/lib/error"
import type {
  GeminiRequest,
  GeminiResponse,
} from "~/routes/gemini/gemini-types"
import type { ResponsesResult } from "~/lib/types/responses"
import { geminiRoutes } from "~/routes/gemini/route"
import { geminiDispatchDependencies } from "~/routes/gemini/dispatch"
import {
  geminiHandlerDependencies,
  translateChatStream,
  translateResponsesStream,
} from "~/routes/gemini/handler"
import { geminiErrorBody } from "~/routes/gemini/errors"
import {
  convertGeminiToChatPayload,
  convertGeminiToMessages,
  buildGeminiParts,
  validateGeminiRequest,
} from "~/routes/gemini/translation"
import {
  responsesResultToGemini,
  toResponsesPayload,
} from "~/routes/gemini/responses"
import {
  interactionToGemini,
  geminiToInteractionSteps,
  interactionDependencies,
} from "~/routes/gemini/interactions"

const request = (): GeminiRequest => ({
  contents: [{ role: "user", parts: [{ text: "Hello" }] }],
})
const app = new Hono().route("/v1beta", geminiRoutes)
const post = (body: unknown, path = "/models/gemini-test:generateContent") =>
  app.request(`/v1beta${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
const native = (extra: Partial<ResponsesResult> = {}): ResponsesResult =>
  ({
    id: "r1",
    model: "gpt-test",
    status: "completed",
    output: [
      {
        type: "message",
        id: "m1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Hello", annotations: [] }],
      },
    ],
    ...extra,
  }) as ResponsesResult
const chat = () => ({
  id: "c1",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "Hello",
        reasoning_text: "Summary",
        reasoning_opaque: "opaque",
      },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
})
const sse = (values: unknown[]) =>
  new Response(values.map((v) => `data: ${JSON.stringify(v)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })
const collect = async <T>(source: AsyncIterable<T>): Promise<T[]> => {
  const values: T[] = []
  for await (const value of source) values.push(value)
  return values
}

type TestBody = GeminiResponse & {
  error: { status: string; code: number; message: string }
  models: unknown[]
  totalTokens: number
  output_text: string
  steps: Array<{ type: string }>
}
const bodyOf = (response: Response) => response.json() as Promise<TestBody>
const originalModels = state.models
const originalDispatch = { ...geminiDispatchDependencies }
const originalHandler = { ...geminiHandlerDependencies }
const originalInteractions = { ...interactionDependencies }
const originalProviders = getConfig().providers
let captured: unknown
let transport: string

beforeEach(() => {
  captured = undefined
  transport = ""
  getConfig().providers = {}
  geminiDispatchDependencies.getProviderConfig = (name) => {
    const config = getConfig().providers?.[name]
    return config ?
        {
          ...config,
          name,
          type:
            config.type === "openai-responses" ?
              "openai-responses"
            : "openai-compatible",
          baseUrl: config.baseUrl ?? "",
          apiKey: config.apiKey ?? "",
          authType: "authorization",
        }
      : null
  }
  geminiDispatchDependencies.resolveConfiguredProviderModelAlias = (name) =>
    Promise.resolve(
      name.startsWith("custom/") ?
        { provider: "custom", model: name.slice(7) }
      : null,
    )
  state.models = {
    object: "list",
    data: [
      {
        ...createFallbackModel("gemini-test"),
        supported_endpoints: ["/chat/completions"],
      },
      {
        ...createFallbackModel("gpt-test"),
        supported_endpoints: ["/responses"],
      },
      {
        ...createFallbackModel("claude-test"),
        supported_endpoints: ["/v1/messages", "/chat/completions"],
      },
    ],
  }
  geminiDispatchDependencies.handleCompletionPayload = (c, payload) => {
    captured = payload
    transport = "chat"
    return Promise.resolve(c.json(chat()))
  }
  geminiDispatchDependencies.handleResponsesPayload = (c, payload) => {
    captured = payload
    transport = "responses"
    return Promise.resolve(c.json(native()))
  }
})
afterEach(() => {
  state.models = originalModels
  getConfig().providers = originalProviders
  Object.assign(geminiDispatchDependencies, originalDispatch)
  Object.assign(geminiHandlerDependencies, originalHandler)
  Object.assign(interactionDependencies, originalInteractions)
})

describe("runtime validation", () => {
  const invalid: unknown[] = [
    null,
    [],
    {},
    { contents: [] },
    { contents: [null] },
    { contents: [{ parts: [] }] },
    { contents: [{ parts: [null] }] },
    ...[
      { text: 5 },
      {},
      { text: "x", inlineData: {} },
      { fileData: { fileUri: "gs://x", mimeType: "image/png" } },
      { inlineData: { mimeType: "application/pdf", data: "eA==" } },
      { inlineData: {} },
      { functionCall: { name: "" } },
      { functionCall: { name: "f", id: 5 } },
      { functionCall: { name: "f", args: [] } },
      { functionResponse: { name: "f", response: null } },
      { text: "x", thoughtSignature: 7 },
      { text: "x", thought: "yes" },
    ].map((part) => ({ contents: [{ role: "user", parts: [part] }] })),
    { ...request(), cachedContent: "cache" },
    { ...request(), tools: {} },
    { ...request(), tools: [{ googleSearch: {} }] },
    {
      ...request(),
      tools: [
        {
          functionDeclarations: [
            { name: "f", parameters: {}, parametersJsonSchema: {} },
          ],
        },
      ],
    },
    {
      ...request(),
      tools: [{ functionDeclarations: [{ name: "f" }, { name: "f" }] }],
    },
    { ...request(), systemInstruction: { parts: [null] } },
    {
      ...request(),
      toolConfig: { functionCallingConfig: { mode: "VALIDATED" } },
    },
    { ...request(), toolConfig: { functionCallingConfig: { mode: "ANY" } } },
    ...[
      { candidateCount: 2 },
      { responseMimeType: "audio/wav" },
      { responseJsonSchema: {} },
      { responseSchema: {}, responseJsonSchema: {} },
      { responseJsonSchema: 3 },
      { responseModalities: ["AUDIO"] },
      { temperature: "warm" },
      { maxOutputTokens: 0 },
      { maxOutputTokens: 1.5 },
      { stopSequences: [3] },
      { thinkingConfig: { thinkingLevel: "MAX" } },
      { thinkingConfig: { thinkingLevel: "LOW", thinkingBudget: 8 } },
      { thinkingConfig: { thinkingBudget: -2 } },
      { thinkingConfig: { includeThoughts: "false" } },
      { thinkingConfig: null },
      { responseFormat: { audio: {} } },
      { responseFormat: { text: { mimeType: "TEXT_PLAIN", schema: {} } } },
    ].map((generationConfig) => ({ ...request(), generationConfig })),
  ]
  test.each(invalid.map((value, index) => [index, value] as const))(
    "rejects invalid request %i",
    async (_index, value) => {
      expect(validateGeminiRequest(value)).not.toBeNull()
      const response = await post(value)
      expect(response.status).toBe(400)
      expect((await bodyOf(response)).error.status).toBe("INVALID_ARGUMENT")
      expect(transport).toBe("")
    },
  )
  test("malformed JSON is 400", async () => {
    const response = await app.request(
      "/v1beta/models/gemini-test:generateContent",
      { method: "POST", body: "{" },
    )
    expect(response.status).toBe(400)
  })
  test("accepts the supported controls", () => {
    expect(
      validateGeminiRequest({
        ...request(),
        systemInstruction: { parts: [{ text: "system" }] },
        tools: [
          {
            functionDeclarations: [
              { name: "f", parametersJsonSchema: { type: "object" } },
            ],
          },
        ],
        toolConfig: {
          functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["f"] },
        },
        generationConfig: {
          responseFormat: {
            text: { mimeType: "APPLICATION_JSON", schema: { type: "object" } },
          },
          thinkingConfig: { thinkingLevel: "LOW", includeThoughts: false },
          candidateCount: 1,
          seed: 1,
          stopSequences: ["end"],
        },
      }),
    ).toBeNull()
  })
})

describe("translation fidelity", () => {
  test("preserves schemas, reasoning controls and allowed tool choice", () => {
    const payload = convertGeminiToChatPayload(
      {
        ...request(),
        tools: [
          {
            functionDeclarations: [
              {
                name: "f",
                parametersJsonSchema: {
                  type: "object",
                  properties: { city: { type: "string" } },
                  required: ["city"],
                },
              },
              { name: "g" },
            ],
          },
        ],
        toolConfig: {
          functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["f"] },
        },
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: { ok: { type: "BOOLEAN" } },
          },
          thinkingConfig: { thinkingLevel: "LOW" },
          seed: 7,
          presencePenalty: 1,
          frequencyPenalty: 0.5,
        },
      },
      "gpt-test",
      false,
    )
    expect(payload.tools).toHaveLength(1)
    expect(payload.tools?.[0].function.parameters).toHaveProperty("required", [
      "city",
    ])
    expect(payload.tool_choice).toEqual({
      type: "function",
      function: { name: "f" },
    })
    expect(payload.response_format).toHaveProperty(
      "json_schema.schema.properties.ok.type",
      "boolean",
    )
    expect(payload.reasoning_effort).toBe("low")
    expect(payload.seed).toBe(7)
    const responses = toResponsesPayload(payload)
    expect(responses.text?.format).toHaveProperty(
      "schema.properties.ok.type",
      "boolean",
    )
    expect(responses.tool_choice).toEqual({ type: "function", name: "f" })
    expect(responses.reasoning?.effort).toBe("low")
  })
  test("preserves out-of-order results and signatures attached to calls", () => {
    const messages = convertGeminiToMessages({
      contents: [
        {
          role: "model",
          parts: [
            {
              functionCall: { id: "a", name: "f", args: { x: 1 } },
              thoughtSignature: "sig",
            },
            { functionCall: { id: "b", name: "f", args: { x: 2 } } },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: { id: "b", name: "f", response: { output: 2 } },
            },
            {
              functionResponse: { id: "a", name: "f", response: { output: 1 } },
            },
          ],
        },
      ],
    })
    expect(messages[0].tool_calls?.map((call) => call.id)).toEqual(["a", "b"])
    expect(messages.slice(1).map((m) => m.tool_call_id)).toEqual(["b", "a"])
    expect(messages[0].reasoning_opaque).toBe("sig")
    const payload = toResponsesPayload({ model: "gpt-test", messages })
    expect(payload.include).toEqual(["reasoning.encrypted_content"])
    expect(payload.input).toContainEqual({
      type: "reasoning",
      encrypted_content: "sig",
      summary: [],
    })
    expect(
      Array.isArray(payload.input)
        && payload.input.some(
          (item) =>
            item.type === "function_call_output" && item.call_id === "b",
        ),
    ).toBe(true)
  })
  test("legacy repeated names receive unique occurrence ids", () => {
    const messages = convertGeminiToMessages({
      contents: [
        {
          role: "model",
          parts: [
            { functionCall: { name: "f" } },
            { functionCall: { name: "f" } },
          ],
        },
        {
          role: "user",
          parts: [
            { functionResponse: { name: "f", response: {} } },
            { functionResponse: { name: "f", response: {} } },
          ],
        },
      ],
    })
    const ids = messages[0].tool_calls!.map((t) => t.id)
    expect(new Set(ids).size).toBe(2)
    expect(messages.slice(1).map((m) => m.tool_call_id)).toEqual(ids)
  })
  test("orphan results and duplicate explicit ids fail", () => {
    expect(() =>
      convertGeminiToMessages({
        contents: [
          {
            parts: [
              { functionResponse: { id: "missing", name: "f", response: {} } },
            ],
          },
        ],
      }),
    ).toThrow("No matching")
    expect(() =>
      convertGeminiToMessages({
        contents: [
          {
            role: "model",
            parts: [
              { functionCall: { id: "a", name: "f" } },
              { functionCall: { id: "a", name: "f" } },
            ],
          },
        ],
      }),
    ).toThrow("Duplicate")
    expect(() =>
      buildGeminiParts(null, [
        { id: "a", type: "function", function: { name: "f", arguments: "{" } },
      ]),
    ).toThrow("malformed")
  })
  test("maps the current responseFormat and image contents", () => {
    const payload = convertGeminiToChatPayload(
      {
        contents: [
          { parts: [{ inlineData: { mimeType: "image/png", data: "eA==" } }] },
        ],
        generationConfig: {
          responseFormat: { text: { mimeType: "APPLICATION_JSON" } },
          thinkingConfig: { thinkingBudget: 200 },
        },
      },
      "model",
      false,
    )
    expect(payload.response_format).toEqual({ type: "json_object" })
    expect(payload.thinking_budget).toBe(200)
    expect(toResponsesPayload(payload).input).toHaveProperty(
      "0.content.0.type",
      "input_image",
    )
  })
})

describe("routing and runtime contracts", () => {
  test("SDK tool aliases preserve JSON Schema property names", async () => {
    const response = await post({
      ...request(),
      tools: [
        {
          function_declarations: [
            {
              name: "f",
              parameters_json_schema: {
                type: "object",
                properties: { thinking_level: { type: "string" } },
              },
            },
          ],
        },
      ],
      tool_config: {
        function_calling_config: { mode: "ANY", allowed_function_names: ["f"] },
      },
    })
    expect(response.status).toBe(200)
    expect(captured).toHaveProperty(
      "tools.0.function.parameters.properties.thinking_level.type",
      "string",
    )
    expect(captured).toHaveProperty("tool_choice.function.name", "f")
  })
  test("structured output requires an advertised Copilot capability", async () => {
    const body = {
      ...request(),
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: { type: "object" },
      },
    }
    expect((await post(body)).status).toBe(400)
    state.models!.data[1].capabilities.supports.structured_outputs = true
    expect((await post(body, "/models/gpt-test:generateContent")).status).toBe(
      200,
    )
    expect(captured).toHaveProperty("text.format.type", "json_schema")
  })
  test.each([
    ["gemini-test", "chat"],
    ["gpt-test", "responses"],
    ["claude-test", "responses"],
  ])("routes %s via %s", async (model, expected) => {
    const response = await post(request(), `/models/${model}:generateContent`)
    expect(response.status).toBe(200)
    expect(transport).toBe(expected)
    expect((await bodyOf(response)).candidates[0].content.parts).toContainEqual(
      { text: "Hello" },
    )
  })
  test("provider aliases with literal slashes reach the configured transport", async () => {
    getConfig().providers = {
      custom: {
        type: "openai-compatible",
        baseUrl: "https://example.com",
        apiKey: "test",
        enabled: true,
      },
    }
    const response = await post(
      request(),
      "/models/custom/model:generateContent",
    )
    expect(response.status).toBe(200)
    expect(captured).toHaveProperty("model", "custom/model")
    expect(transport).toBe("chat")
  })
  test("provider Responses aliases use the Responses handler", async () => {
    getConfig().providers = {
      custom: {
        type: "openai-responses",
        baseUrl: "https://example.com",
        apiKey: "test",
        enabled: true,
      },
    }
    expect(
      (await post(request(), "/models/custom%2Fmodel:generateContent")).status,
    ).toBe(200)
    expect(transport).toBe("responses")
  })
  test("unknown models return 404 for generation and lookup", async () => {
    expect(
      (await post(request(), "/models/gemini-missing:generateContent")).status,
    ).toBe(404)
    expect((await app.request("/v1beta/models/gemini-missing")).status).toBe(
      404,
    )
    expect((await app.request("/v1beta/models/gemini-test")).status).toBe(200)
  })
  test("accepts SDK thinking aliases and rejects conflicting spellings", async () => {
    const response = await post({
      ...request(),
      generationConfig: {
        thinkingConfig: { include_thoughts: false, thinking_level: "LOW" },
      },
    })
    expect(response.status).toBe(200)
    expect(
      (await bodyOf(response)).candidates[0].content.parts.some(
        (p) => "thought" in p && p.thought,
      ),
    ).toBe(false)
    expect(captured).toHaveProperty("reasoning_effort", "low")
    expect(
      (
        await post({
          ...request(),
          generationConfig: {
            thinkingConfig: { include_thoughts: false, includeThoughts: true },
          },
        })
      ).status,
    ).toBe(400)
  })
  test("content filtering remains a safety finish reason", () => {
    expect(
      responsesResultToGemini(
        native({
          status: "incomplete",
          incomplete_details: { reason: "content_filter" },
        }),
      ).candidates[0].finishReason,
    ).toBe("SAFETY")
  })
  test("suppresses thoughts but retains signatures", async () => {
    const response = await post({
      ...request(),
      generationConfig: { thinkingConfig: { includeThoughts: false } },
    })
    const parts = (await bodyOf(response)).candidates[0].content.parts
    expect(parts.some((p) => "thought" in p && p.thought)).toBe(false)
    expect(parts).toContainEqual({ text: "", thoughtSignature: "opaque" })
  })
  test("token counting works with both request shapes and is labelled estimated", async () => {
    for (const invalid of ["hello", 42, null])
      expect(
        (await post(invalid, "/models/gemini-test:countTokens")).status,
      ).toBe(400)
    for (const body of [
      request(),
      { generateContentRequest: { ...request(), model: "models/gemini-test" } },
    ]) {
      const response = await post(body, "/models/gemini-test:countTokens")
      expect(response.status).toBe(200)
      expect(response.headers.get("x-copilot-api-token-count")).toBe(
        "estimated",
      )
      expect((await bodyOf(response)).totalTokens).toBeGreaterThan(0)
    }
  })
  test("unsupported methods, fields and transport controls are explicit", async () => {
    expect(
      (await post({ ...request(), generationConfig: { topK: 40 } })).status,
    ).toBe(400)
    expect(
      (await post(request(), "/models/gemini-test:embedContent")).status,
    ).toBe(404)
    expect(
      (
        await post(
          { ...request(), generationConfig: { stopSequences: ["x"] } },
          "/models/gpt-test:generateContent",
        )
      ).status,
    ).toBe(400)
    expect(
      (
        await post({
          ...request(),
          generationConfig: { thinkingConfig: { thinkingBudget: 5 } },
        })
      ).status,
    ).toBe(400)
  })
  test("catalog excludes embedding models", async () => {
    geminiHandlerDependencies.getAggregatedModels = () =>
      Promise.resolve([
        { id: "gpt-test", object: "model" },
        { id: "embedding", object: "model" },
      ])
    const response = await app.request("/v1beta/models")
    expect((await bodyOf(response)).models).toHaveLength(1)
  })
  test("upstream failures keep Gemini status and Retry-After", async () => {
    geminiDispatchDependencies.handleCompletionPayload = async () => {
      await Promise.resolve()
      throw new HTTPError(
        "upstream",
        new Response(JSON.stringify({ error: { message: "Slow down" } }), {
          status: 429,
          headers: { "retry-after": "3" },
        }),
      )
    }
    const response = await post(request())
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("3")
    expect((await bodyOf(response)).error).toEqual({
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      message: "Slow down",
    })
    expect(
      await geminiErrorBody(new UpstreamHeadersTimeoutError(10)),
    ).toHaveProperty("error.code", 504)
    expect(await geminiErrorBody(new Error("private"))).toHaveProperty(
      "error.message",
      "Internal server error",
    )
    expect(
      await geminiErrorBody(
        Object.assign(new Error("cancel"), { name: "AbortError" }),
      ),
    ).toHaveProperty("error.code", 499)
  })
})

describe("streaming", () => {
  test("chat forwards reasoning, text and complete tool arguments once", async () => {
    const chunks = await collect(
      translateChatStream(
        sse([
          {
            choices: [
              {
                delta: { reasoning_text: "Think", reasoning_opaque: "sig" },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  content: "Hello",
                  tool_calls: [
                    {
                      index: 0,
                      id: "a",
                      function: { name: "f", arguments: '{"x":' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: "1}" } }],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          },
        ]),
        "model",
      ),
    )
    expect(chunks[0].candidates[0].content.parts).toContainEqual({
      text: "Think",
      thought: true,
    })
    expect(chunks.at(-1)?.candidates[0].content.parts).toContainEqual({
      functionCall: { id: "a", name: "f", args: { x: 1 } },
    })
    expect(chunks.at(-1)?.usageMetadata?.totalTokenCount).toBe(3)
  })
  test("truncation and upstream errors never become successful STOP", () => {
    expect(
      collect(
        translateChatStream(sse([{ error: { message: "failed" } }]), "model"),
      ),
    ).rejects.toThrow("failed")
    expect(collect(translateChatStream(sse([]), "model"))).rejects.toThrow(
      "before completion",
    )
    expect(
      collect(
        translateResponsesStream(sse([{ type: "error", message: "failed" }])),
      ),
    ).rejects.toThrow("failed")
    expect(collect(translateResponsesStream(sse([])))).rejects.toThrow(
      "before completion",
    )
  })
  test("Responses deltas do not repeat text in the terminal chunk", async () => {
    const chunks = await collect(
      translateResponsesStream(
        sse([
          { type: "response.output_text.delta", delta: "Hello" },
          { type: "response.completed", response: native() },
        ]),
      ),
    )
    expect(chunks[0].candidates[0].content.parts).toEqual([{ text: "Hello" }])
    expect(chunks[1].candidates[0].content.parts).toEqual([{ text: "" }])
    expect(chunks[1].candidates[0].finishReason).toBe("STOP")
  })
  test("Responses carries tools, signatures, usage and incomplete status", () => {
    const result = responsesResultToGemini(
      native({
        status: "incomplete",
        output: [
          {
            type: "reasoning",
            id: "r",
            encrypted_content: "opaque",
            summary: [{ type: "summary_text", text: "Summary" }],
          },
          {
            type: "function_call",
            id: "fc",
            call_id: "a",
            name: "f",
            arguments: "{}",
            status: "completed",
          },
        ],
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          total_tokens: 3,
          output_tokens_details: { reasoning_tokens: 1 },
        },
      }),
    )
    expect(result.candidates[0].finishReason).toBe("MAX_TOKENS")
    expect(result.candidates[0].content.parts).toContainEqual({
      functionCall: { id: "a", name: "f", args: {} },
    })
    expect(result.usageMetadata?.thoughtsTokenCount).toBe(1)
    expect(() => responsesResultToGemini(native({ status: "failed" }))).toThrow(
      "failed",
    )
  })
})

describe("stateless Interactions", () => {
  test.each([
    { model: "m", input: "hi" },
    { store: true },
    { store: false, background: true },
    { store: false, previous_interaction_id: "x" },
    { store: false, agent: "a" },
  ])("rejects stateful request %j", async (body) => {
    const response = await post(body, "/interactions")
    expect([400, 501]).toContain(response.status)
    expect(transport).toBe("")
  })
  test("converts full tool history and turn-scoped controls", () => {
    const { request: body } = interactionToGemini({
      model: "m",
      store: false,
      system_instruction: "system",
      tools: [{ type: "function", name: "f", parameters: { type: "object" } }],
      generation_config: {
        thinking_level: "low",
        thinking_summaries: "none",
        max_output_tokens: 100,
      },
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: { type: "object" },
      },
      input: [
        { type: "user_input", content: [{ type: "text", text: "hi" }] },
        { type: "thought", signature: "sig", summary: [] },
        { type: "function_call", id: "a", name: "f", arguments: {} },
        {
          type: "function_result",
          call_id: "a",
          name: "f",
          result: [{ type: "text", text: "done" }],
        },
      ],
    })
    expect(validateGeminiRequest(body)).toBeNull()
    expect(convertGeminiToMessages(body).at(-1)?.tool_call_id).toBe("a")
    expect(body.generationConfig?.thinkingConfig?.includeThoughts).toBe(false)
  })
  test("returns the steps schema and streams typed events", async () => {
    for (const stream of [false, true]) {
      const response = await post(
        { model: "gemini-test", input: "Hello", store: false, stream },
        "/interactions",
      )
      expect(response.status).toBe(200)
      if (stream) {
        const body = await response.text()
        for (const name of [
          "interaction.created",
          "step.start",
          "step.delta",
          "step.stop",
          "interaction.completed",
        ])
          expect(body).toContain(name)
      } else {
        const body = await bodyOf(response)
        expect(body.output_text).toBe("Hello")
        expect(
          body.steps.some((s: { type: string }) => s.type === "model_output"),
        ).toBe(true)
      }
    }
  })
  test("supports inline images and rejects hosted tools", () => {
    expect(
      interactionToGemini({
        model: "m",
        store: false,
        input: [
          {
            type: "user_input",
            content: [{ type: "image", mime_type: "image/png", data: "eA==" }],
          },
        ],
      }).request.contents[0].parts[0],
    ).toHaveProperty("inlineData")
    expect(() =>
      interactionToGemini({
        model: "m",
        store: false,
        input: "hi",
        tools: [{ type: "google_search" }],
      }),
    ).toThrow("Only function")
  })
  test("maps output tool identity and exposes unsupported retrieval", async () => {
    const response: GeminiResponse = {
      candidates: [
        {
          index: 0,
          content: {
            role: "model",
            parts: [{ functionCall: { id: "a", name: "f", args: {} } }],
          },
        },
      ],
    }
    expect(geminiToInteractionSteps(response)).toEqual([
      { type: "function_call", id: "a", name: "f", arguments: {} },
    ])
    expect((await app.request("/v1beta/interactions/id")).status).toBe(501)
  })
  test("stream errors produce error events without completion", async () => {
    interactionDependencies.generateGemini = () =>
      Promise.resolve(sse([{ error: { message: "failure" } }]))
    const response = await post(
      { model: "m", input: "hi", store: false, stream: true },
      "/interactions",
    )
    const body = await response.text()
    expect(body).toContain('"event_type":"error"')
    expect(body).not.toContain('"event_type":"interaction.completed"')
  })
})
