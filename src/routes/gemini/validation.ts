import type { GeminiRequest } from "./gemini-types"
import { GeminiError } from "./errors"

/** Runtime validation for the supported Gemini request subset. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function validatePart(part: unknown): string | null {
  if (!isRecord(part)) return "parts must contain objects"
  const kinds = [
    "text",
    "inlineData",
    "inline_data",
    "fileData",
    "functionCall",
    "functionResponse",
  ].filter((key) => key in part)
  if (kinds.length !== 1)
    return "Each part must contain exactly one supported content type"
  if (
    part.thoughtSignature !== undefined
    && typeof part.thoughtSignature !== "string"
  )
    return "thoughtSignature must be a string"
  if (part.thought !== undefined && typeof part.thought !== "boolean")
    return "thought must be a boolean"
  if ("text" in part)
    return typeof part.text === "string" ? null : "text must be a string"
  if ("inlineData" in part || "inline_data" in part) {
    const data = part.inlineData ?? part.inline_data
    if (!isRecord(data) || typeof data.data !== "string" || !data.data)
      return "inlineData requires base64 data"
    const mime = data.mimeType ?? data.mime_type
    if (typeof mime !== "string" || !mime.startsWith("image/"))
      return "Only inline images are supported; PDF, audio and video require a supported upstream attachment API"
    return null
  }
  if ("fileData" in part)
    return "fileData is not supported; send an inline image instead"
  const call = part.functionCall ?? part.functionResponse
  if (!isRecord(call) || typeof call.name !== "string" || !call.name.trim())
    return "Function parts require a non-empty name"
  if (call.id !== undefined && (typeof call.id !== "string" || !call.id))
    return "Function ids must be non-empty strings"
  if (part.functionCall && call.args !== undefined && !isRecord(call.args))
    return "Function arguments must be an object"
  if (part.functionResponse && !isRecord(call.response))
    return "Function response must be a JSON object"
  if (call.parts !== undefined)
    return "Multimodal function responses are not supported"
  return null
}

/** Validate before casting; unsupported semantic controls fail rather than disappearing. */
export function validateRequest(request: unknown): string | null {
  if (!isRecord(request) || !Array.isArray(request.contents))
    return "contents is required and must be an array"
  if (!request.contents.length) return "contents array cannot be empty"
  for (const key of Object.keys(request)) {
    if (
      ![
        "contents",
        "systemInstruction",
        "tools",
        "toolConfig",
        "generationConfig",
      ].includes(key)
    )
      return `Unsupported request field: ${key}`
  }
  for (const [i, content] of request.contents.entries()) {
    if (!isRecord(content) || !Array.isArray(content.parts))
      return `contents[${i}].parts is required and must be an array`
    if (
      content.role !== undefined
      && !["user", "model"].includes(content.role as string)
    )
      return `contents[${i}].role must be 'user' or 'model'`
    if (!content.parts.length) return "parts cannot be empty"
    for (const part of content.parts) {
      const error = validatePart(part)
      if (error) return error
      if (
        isRecord(part)
        && ((part.functionCall && content.role !== "model")
          || (part.functionResponse && content.role === "model"))
      )
        return "Function calls require model role and function responses require user role"
    }
  }
  if (request.systemInstruction !== undefined) {
    const system = request.systemInstruction
    if (
      !isRecord(system)
      || !Array.isArray(system.parts)
      || system.parts.some(
        (p) =>
          !isRecord(p)
          || typeof p.text !== "string"
          || Object.keys(p).some((k) => k !== "text"),
      )
    )
      return "systemInstruction requires text parts"
  }
  if (request.tools !== undefined && !Array.isArray(request.tools))
    return "tools must be an array"
  const names = new Set<string>()
  for (const tool of (request.tools ?? []) as unknown[]) {
    if (
      !isRecord(tool)
      || Object.keys(tool).some((k) => k !== "functionDeclarations")
      || !Array.isArray(tool.functionDeclarations)
    )
      return "Only functionDeclarations tools are supported"
    for (const decl of tool.functionDeclarations) {
      if (!isRecord(decl) || typeof decl.name !== "string" || !decl.name.trim())
        return "Function declarations require a name"
      if (names.has(decl.name))
        return "Function declaration names must be unique"
      names.add(decl.name)
      if (
        decl.parameters !== undefined
        && decl.parametersJsonSchema !== undefined
      )
        return "parameters and parametersJsonSchema are mutually exclusive"
      for (const key of Object.keys(decl))
        if (
          ![
            "name",
            "description",
            "parameters",
            "parametersJsonSchema",
          ].includes(key)
        )
          return `Unsupported function declaration field: ${key}`
      for (const schema of [decl.parameters, decl.parametersJsonSchema])
        if (schema !== undefined && !isRecord(schema))
          return "Function parameter schemas must be objects"
    }
  }
  if (request.toolConfig !== undefined) {
    if (
      !isRecord(request.toolConfig)
      || Object.keys(request.toolConfig).some(
        (k) => k !== "functionCallingConfig",
      )
    )
      return "Unsupported toolConfig"
    const fc = request.toolConfig.functionCallingConfig
    if (
      !isRecord(fc)
      || Object.keys(fc).some(
        (k) => !["mode", "allowedFunctionNames"].includes(k),
      )
    )
      return "Invalid functionCallingConfig"
    if (
      fc.mode !== undefined
      && !["AUTO", "ANY", "NONE", "VALIDATED"].includes(fc.mode as string)
    )
      return "Unsupported function calling mode"
    if (fc.mode === "VALIDATED")
      return "VALIDATED function calling is not supported by this gateway"
    if (
      fc.allowedFunctionNames !== undefined
      && (fc.mode !== "ANY"
        || !Array.isArray(fc.allowedFunctionNames)
        || !fc.allowedFunctionNames.length
        || fc.allowedFunctionNames.some(
          (n) => typeof n !== "string" || !names.has(n),
        ))
    )
      return "allowedFunctionNames requires ANY mode and declared function names"
    if (fc.mode === "ANY" && !names.size)
      return "ANY mode requires function declarations"
  }
  return validateConfig(request.generationConfig)
}

function validateConfig(config: unknown): string | null {
  if (config === undefined) return null
  if (!isRecord(config)) return "generationConfig must be an object"
  const numeric = [
    "temperature",
    "topP",
    "topK",
    "maxOutputTokens",
    "seed",
    "presencePenalty",
    "frequencyPenalty",
    "candidateCount",
  ]
  const fields = [
    ...numeric,
    "stopSequences",
    "responseMimeType",
    "responseSchema",
    "responseJsonSchema",
    "responseFormat",
    "thinkingConfig",
  ]
  for (const key of Object.keys(config))
    if (!fields.includes(key))
      return `Unsupported generationConfig field: ${key}`
  for (const key of numeric)
    if (
      config[key] !== undefined
      && (typeof config[key] !== "number" || !Number.isFinite(config[key]))
    )
      return `${key} must be a finite number`
  if (
    config.maxOutputTokens !== undefined
    && (!Number.isInteger(config.maxOutputTokens)
      || Number(config.maxOutputTokens) < 1)
  )
    return "maxOutputTokens must be a positive integer"
  if (config.candidateCount !== undefined && config.candidateCount !== 1)
    return "Only candidateCount=1 is supported"
  if (config.topK !== undefined)
    return "topK is not supported by the gateway transports"
  if (
    config.stopSequences !== undefined
    && (!Array.isArray(config.stopSequences)
      || config.stopSequences.some((v) => typeof v !== "string"))
  )
    return "stopSequences must contain strings"
  if (
    config.responseMimeType !== undefined
    && !["application/json", "text/plain"].includes(
      config.responseMimeType as string,
    )
  )
    return "Unsupported responseMimeType"
  if (
    config.responseSchema !== undefined
    && config.responseJsonSchema !== undefined
  )
    return "responseSchema and responseJsonSchema are mutually exclusive"
  for (const key of ["responseSchema", "responseJsonSchema"])
    if (config[key] !== undefined && !isRecord(config[key]))
      return `${key} must be an object`
  if (
    (config.responseSchema || config.responseJsonSchema)
    && config.responseMimeType !== "application/json"
  )
    return "Response schemas require responseMimeType=application/json"
  if (config.responseFormat !== undefined) {
    const format = config.responseFormat
    if (
      config.responseMimeType
      || config.responseSchema
      || config.responseJsonSchema
    )
      return "responseFormat cannot be combined with legacy response format fields"
    if (
      !isRecord(format)
      || Object.keys(format).some((k) => k !== "text")
      || !isRecord(format.text)
    )
      return "Only responseFormat.text is supported"
    if (
      Object.keys(format.text).some((k) => !["mimeType", "schema"].includes(k))
    )
      return "Unsupported text response format field"
    if (
      !["APPLICATION_JSON", "TEXT_PLAIN"].includes(String(format.text.mimeType))
    )
      return "Unsupported responseFormat.text.mimeType"
    if (
      format.text.schema !== undefined
      && (format.text.mimeType !== "APPLICATION_JSON"
        || !isRecord(format.text.schema))
    )
      return "A JSON text response format is required for schema"
  }
  if (config.thinkingConfig !== undefined) {
    const thinking = config.thinkingConfig
    if (
      !isRecord(thinking)
      || Object.keys(thinking).some(
        (k) =>
          !["thinkingLevel", "thinkingBudget", "includeThoughts"].includes(k),
      )
    )
      return "Unsupported thinkingConfig"
    if (
      thinking.thinkingLevel !== undefined
      && !["MINIMAL", "LOW", "MEDIUM", "HIGH"].includes(
        thinking.thinkingLevel as string,
      )
    )
      return "Unsupported thinkingLevel"
    if (
      thinking.thinkingBudget !== undefined
      && (!Number.isInteger(thinking.thinkingBudget)
        || Number(thinking.thinkingBudget) < -1)
    )
      return "thinkingBudget must be an integer >= -1"
    if (
      thinking.thinkingBudget !== undefined
      && thinking.thinkingLevel !== undefined
    )
      return "thinkingBudget and thinkingLevel are mutually exclusive"
    if (
      thinking.includeThoughts !== undefined
      && typeof thinking.includeThoughts !== "boolean"
    )
      return "includeThoughts must be a boolean"
  }
  return null
}

/** Accept protobuf snake_case aliases without rewriting user schemas or tool data. */
export function normalizeGeminiRequest(request: GeminiRequest): GeminiRequest {
  const opaque = new Set([
    "parameters",
    "parametersJsonSchema",
    "responseSchema",
    "responseJsonSchema",
    "schema",
    "args",
    "response",
  ])
  const aliases: Record<string, string> = {
    generation_config: "generationConfig",
    system_instruction: "systemInstruction",
    tool_config: "toolConfig",
    function_declarations: "functionDeclarations",
    function_calling_config: "functionCallingConfig",
    allowed_function_names: "allowedFunctionNames",
    parameters_json_schema: "parametersJsonSchema",
    thinking_config: "thinkingConfig",
    thinking_level: "thinkingLevel",
    thinking_budget: "thinkingBudget",
    include_thoughts: "includeThoughts",
    inline_data: "inlineData",
    mime_type: "mimeType",
    file_data: "fileData",
    file_uri: "fileUri",
    function_call: "functionCall",
    function_response: "functionResponse",
    thought_signature: "thoughtSignature",
    max_output_tokens: "maxOutputTokens",
    top_p: "topP",
    top_k: "topK",
    candidate_count: "candidateCount",
    stop_sequences: "stopSequences",
    response_mime_type: "responseMimeType",
    response_schema: "responseSchema",
    response_json_schema: "responseJsonSchema",
    response_format: "responseFormat",
    presence_penalty: "presencePenalty",
    frequency_penalty: "frequencyPenalty",
  }
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize)
    if (!isRecord(value)) return value
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const canonical = aliases[key] ?? key
      if (canonical !== key && canonical in value)
        throw new GeminiError(`Do not specify both ${key} and ${canonical}`)
      result[canonical] = opaque.has(canonical) ? item : normalize(item)
    }
    return result
  }
  return normalize(request) as GeminiRequest
}
