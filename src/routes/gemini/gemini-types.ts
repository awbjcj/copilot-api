// Google Gemini (generateContent) API Types
//
// This dialect lets clients using the google-genai SDK (pointed at this
// proxy's base URL) talk to Copilot models. It mirrors the Anthropic and
// OpenAI support: incoming Gemini requests are converted to the internal
// OpenAI chat-completions format and served through Copilot, then the response
// is converted back to the Gemini wire format.
//
// The proxy does not call Google's API and requires no GEMINI_API_KEY; it only
// speaks the Gemini wire format while the responses come from Copilot models.
// @see https://ai.google.dev/api/generate-content

/**
 * A single Gemini content part. Text and function-call/response parts are
 * supported; other part kinds (inlineData, fileData) are ignored during
 * conversion since the internal format is text/tool oriented.
 */
export type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args?: Record<string, unknown> } }
  | { functionResponse: { name: string; response: unknown } }

/**
 * A Gemini content turn. Role is 'user' (human/tool input) or 'model'
 * (assistant output). systemInstruction reuses this shape.
 */
export interface GeminiContent {
  role?: "user" | "model"
  parts: Array<GeminiPart>
}

/**
 * A Gemini function declaration (tool).
 */
export interface GeminiFunctionDeclaration {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

/**
 * A Gemini tool entry - a group of function declarations.
 */
export interface GeminiTool {
  functionDeclarations?: Array<GeminiFunctionDeclaration>
}

/**
 * Gemini generation configuration (subset).
 */
export interface GeminiGenerationConfig {
  temperature?: number
  topP?: number
  topK?: number
  maxOutputTokens?: number
  stopSequences?: Array<string>
}

/**
 * Gemini generateContent request body.
 */
export interface GeminiRequest {
  contents: Array<GeminiContent>
  systemInstruction?: GeminiContent
  tools?: Array<GeminiTool>
  toolConfig?: {
    functionCallingConfig?: {
      mode?: "AUTO" | "ANY" | "NONE"
      allowedFunctionNames?: Array<string>
    }
  }
  generationConfig?: GeminiGenerationConfig
}

export type GeminiFinishReason =
  | "STOP"
  | "MAX_TOKENS"
  | "SAFETY"
  | "RECITATION"
  | "OTHER"

/**
 * A Gemini response candidate.
 */
export interface GeminiCandidate {
  content: GeminiContent
  finishReason?: GeminiFinishReason
  index: number
}

/**
 * Token usage metadata for a Gemini response.
 */
export interface GeminiUsageMetadata {
  promptTokenCount: number
  candidatesTokenCount: number
  totalTokenCount: number
}

/**
 * Gemini generateContent response body (also used for streaming chunks).
 */
export interface GeminiResponse {
  candidates: Array<GeminiCandidate>
  usageMetadata?: GeminiUsageMetadata
  modelVersion?: string
  responseId?: string
}

export interface GeminiErrorResponse {
  error: {
    code: number
    message: string
    status: string
  }
}
