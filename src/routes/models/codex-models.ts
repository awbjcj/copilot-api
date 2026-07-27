import type { Context } from "hono"

import type { ResolvedProviderConfig } from "~/lib/config"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import type { CodexModelsResponse } from "~/routes/models/codex-models-types"
import { forwardCodexModels } from "~/services/codex/get-models"
import { createProviderProxyResponse } from "~/services/providers/provider-proxy"

const logger = createHandlerLogger("codex-models-handler")
const CODEX_USER_AGENT_PATTERN = /^codex/iu

export function isCodexUserAgent(userAgent: string | undefined): boolean {
  return CODEX_USER_AGENT_PATTERN.test(userAgent?.trim() ?? "")
}

async function logCodexModelsResponse(response: Response): Promise<void> {
  try {
    const models = (await response.clone().json()) as CodexModelsResponse
    debugJson(logger, "models.codex.response", {
      statusCode: response.status,
      models,
    })
  } catch (error) {
    logger.warn("models.codex.response_log_error", { error })
  }
}

/**
 * Proxies a models request to the fixed Codex upstream models endpoint.
 * Returns a 404 JSON response when the codex provider is unavailable.
 * Pass `resolvedProviderConfig` when the caller already resolved the codex
 * provider to avoid a second resolve.
 */
export async function handleCodexModelsProxy(
  c: Context,
  resolvedProviderConfig?: ResolvedProviderConfig,
): Promise<Response> {
  const codexProviderConfig =
    resolvedProviderConfig ?? (await resolveProviderConfig("codex"))
  if (!codexProviderConfig) {
    return c.json(
      {
        error: {
          message: "Provider 'codex' not found or disabled",
          type: "invalid_request_error",
        },
      },
      404,
    )
  }

  const upstreamResponse = await forwardCodexModels(
    c.req.url,
    c.req.raw.headers,
  )
  await logCodexModelsResponse(upstreamResponse)
  return createProviderProxyResponse(upstreamResponse)
}
