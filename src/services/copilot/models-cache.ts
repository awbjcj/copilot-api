import consola from "consola"

import { state } from "~/lib/state"
import { getModels as getCopilotModels } from "~/services/copilot/get-models"

// Periodically refresh models so long-running daemons pick up new SKUs.
const MODELS_REFRESH_BASE_MS = 30 * 60 * 1000
let modelsRefreshTimer: ReturnType<typeof setTimeout> | null = null

export const stopModelsRefreshLoop = () => {
  if (modelsRefreshTimer) {
    clearTimeout(modelsRefreshTimer)
    modelsRefreshTimer = null
  }
}

type ModelsFetcher = typeof getCopilotModels

const refreshModels = async (fetcher: ModelsFetcher) => {
  const prevIds = new Set(state.models?.data.map((m) => m.id) ?? [])
  const models = await fetcher()
  state.models = {
    ...models,
    data: models.data.filter(
      (model) =>
        model.policy?.state !== "disabled"
        && (model.model_picker_enabled
          || model.capabilities.type === "embeddings"),
    ),
  }
  const nextIds = state.models.data.map((m) => m.id)
  const added = nextIds.filter((id) => !prevIds.has(id))
  if (added.length > 0) {
    consola.info(`Models refresh: ${added.length} new`)
  } else {
    consola.debug(`Models refresh: no changes (${nextIds.length} total)`)
  }
}

const scheduleModelsRefresh = (fetcher: ModelsFetcher, intervalMs: number) => {
  const jitter = Math.floor(Math.random() * (intervalMs / 6))
  const delay = intervalMs + jitter
  consola.debug(
    `Scheduling next models refresh in ${Math.round(delay / 1000)} seconds`,
  )

  stopModelsRefreshLoop()
  modelsRefreshTimer = setTimeout(async () => {
    try {
      await refreshModels(fetcher)
    } catch (error) {
      consola.warn("Failed to refresh models, keeping previous cache.", error)
    } finally {
      scheduleModelsRefresh(fetcher, intervalMs)
    }
  }, delay)
}

export async function cacheModels(
  fetcher: ModelsFetcher = getCopilotModels,
  intervalMs: number = MODELS_REFRESH_BASE_MS,
): Promise<void> {
  await refreshModels(fetcher)
  scheduleModelsRefresh(fetcher, intervalMs)
}
