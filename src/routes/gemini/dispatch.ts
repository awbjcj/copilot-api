import type { Context } from "hono"
import {
  getProviderConfig,
  resolveMappedModel,
  resolveProviderConfigForModel,
} from "~/lib/config"
import { findEndpointModel } from "~/lib/models"
import { resolveConfiguredProviderModelAlias } from "~/lib/provider-resolver"
import { createFallbackModel } from "~/lib/provider-model"
import { isGitHubCopilotEnabled } from "~/lib/github-copilot-provider"
import { handleCompletionPayload } from "~/routes/chat-completions/handler"
import { handleResponsesPayload } from "~/routes/responses/handler"
import type { GeminiRequest } from "./gemini-types"
import { convertGeminiToChatPayload } from "./translation"
import { toResponsesPayload } from "./responses"
import { GeminiError } from "./errors"

export const geminiDispatchDependencies = {
  getProviderConfig,
  handleCompletionPayload,
  handleResponsesPayload,
  resolveConfiguredProviderModelAlias,
}

/** Resolve explicit aliases and known models; never silently substitute another model. */
export async function resolveGeminiModel(requested: string) {
  const mapped = resolveMappedModel(requested)
  const alias =
    await geminiDispatchDependencies.resolveConfiguredProviderModelAlias(mapped)
  if (alias) {
    const provider = geminiDispatchDependencies.getProviderConfig(
      alias.provider,
    )
    const effective =
      provider && resolveProviderConfigForModel(provider, alias.model)
    return {
      id: mapped,
      model: createFallbackModel(mapped),
      responses: effective?.type !== "openai-compatible",
      provider: true,
    }
  }
  const model = isGitHubCopilotEnabled() ? findEndpointModel(mapped) : undefined
  if (!model || model.capabilities.type !== "chat")
    throw new GeminiError(`Model not found: ${requested}`, 404)
  const endpoints = model.supported_endpoints ?? []
  return {
    id: model.id,
    model,
    responses: endpoints.some((e) =>
      ["/responses", "ws:/responses", "/v1/messages"].includes(e),
    ),
    provider: false,
  }
}

const THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const

/**
 * Converts a legacy Gemini thinkingBudget to a thinking level for models that
 * only accept levels. -1 (dynamic) leaves the model default. The level is
 * moved to the nearest supported one, preferring more thinking over less.
 */
export function thinkingBudgetToLevel(
  budget: number,
  supported?: Array<string>,
): string | undefined {
  if (budget < 0) return undefined
  let index: number
  if (budget === 0) index = 0
  else if (budget <= 1024) index = 1
  else if (budget <= 8192) index = 2
  else index = 3
  if (!supported?.length) return THINKING_LEVELS[index]
  for (let i = index; i < THINKING_LEVELS.length; i++)
    if (supported.includes(THINKING_LEVELS[i])) return THINKING_LEVELS[i]
  for (let i = index - 1; i >= 0; i--)
    if (supported.includes(THINKING_LEVELS[i])) return THINKING_LEVELS[i]
  return undefined
}

/** Route via the existing gateway handlers so provider policy and cancellation are shared. */
export async function dispatchGemini(
  c: Context,
  request: GeminiRequest,
  modelName: string,
  stream: boolean,
) {
  const resolved = await resolveGeminiModel(modelName)
  const payload = convertGeminiToChatPayload(request, resolved.id, stream)
  const supports = resolved.model.capabilities.supports
  if (
    !resolved.provider
    && payload.response_format
    && supports.structured_outputs !== true
  )
    throw new GeminiError(
      "This Copilot model does not advertise structured output support; choose a model with structured_outputs support",
    )
  if (
    !resolved.provider
    && payload.tools?.length
    && supports.tool_calls === false
  )
    throw new GeminiError("This model does not support function calling")
  if (
    !resolved.provider
    && payload.messages.some(
      (m) =>
        Array.isArray(m.content)
        && m.content.some((p) => p.type === "image_url"),
    )
    && supports.vision === false
  )
    throw new GeminiError("This model does not support images")
  const geminiVersion = /^gemini-(\d+)(?:[.-]|$)/i.exec(
    resolved.id.split("/").at(-1) ?? "",
  )
  if (
    payload.thinking_budget !== undefined
    && ((geminiVersion && Number(geminiVersion[1]) >= 3)
      || (!resolved.provider && !supports.max_thinking_budget)
      || resolved.responses)
  ) {
    const level = thinkingBudgetToLevel(
      payload.thinking_budget,
      supports.reasoning_effort,
    )
    delete payload.thinking_budget
    if (level) payload.reasoning_effort = level
  }
  if (
    payload.reasoning_effort
    && supports.reasoning_effort?.length
    && !supports.reasoning_effort.includes(payload.reasoning_effort)
  )
    throw new GeminiError(
      `Unsupported thinking level for ${resolved.id}; supported: ${supports.reasoning_effort.join(", ")}`,
    )
  if (resolved.responses) {
    if (
      payload.stop?.length
      || payload.seed !== undefined
      || payload.presence_penalty !== undefined
      || payload.frequency_penalty !== undefined
    )
      throw new GeminiError(
        "stopSequences, seed and penalties are not supported by this model's Responses transport",
      )
    return {
      response: await geminiDispatchDependencies.handleResponsesPayload(
        c,
        toResponsesPayload(payload),
        { skipModelMapping: true },
      ),
      dialect: "responses" as const,
      model: resolved.id,
    }
  }
  return {
    response: await geminiDispatchDependencies.handleCompletionPayload(
      c,
      payload,
      { skipModelMapping: true },
    ),
    dialect: "chat" as const,
    model: resolved.id,
  }
}
