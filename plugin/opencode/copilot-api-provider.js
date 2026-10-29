const providerID = "local"
const responsesPackage = "@opencode/ai/providers/openai/responses"

// Image models the gateway can serve but does not advertise in its chat model
// catalog. OpenCode only registers its image_generate tool while some model
// reports an "image" output capability, so they are added to the catalog here.
// Override with the plugin's imageModels option, or pass [] to disable.
const defaultImageModels = [{ id: "codex/gpt-image-2", name: "GPT Image 2" }]

const buildImageModel = (model) => ({
  id: model.id,
  modelID: model.id,
  providerID,
  package: responsesPackage,
  name: model.name ?? model.id,
  family: "gpt-image",
  status: "active",
  enabled: true,
  capabilities: { tools: false, input: ["text", "image"], output: ["image"] },
  variants: [],
  time: { released: 0 },
  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
  limit: { context: 0, output: 0 },
})

// Single-file plugin for OpenCode's v2 branch; no imports or dependencies.
export default {
  id: "local.provider",
  async setup(ctx) {
    const options = ctx.options ?? {}
    const baseURL = (
      options.baseURL
      ?? process.env.COPILOT_API_URL
      ?? "http://localhost:4141/v1"
    ).replace(/\/+$/u, "")
    const apiKey = options.apiKey ?? process.env.GITHUB_COPILOT_API_KEY ?? "dummy"
    const refreshIntervalMs = options.refreshIntervalMs ?? 120_000
    const imageModels = options.imageModels ?? defaultImageModels
    const loadModels = async () => {
      const response = await fetch(`${baseURL}/models`, {
        headers: {
          "user-agent": "opencode/copilot-api-provider",
          "x-api-key": apiKey,
        },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) {
        throw new Error(`Model discovery failed: HTTP ${response.status}`)
      }
      const body = await response.json()
      if (
        !Array.isArray(body?.data)
        || !body.data.every((model) =>
          typeof model?.id === "string"
          && typeof model?.modelID === "string"
          && model?.capabilities
          && Array.isArray(model?.cost),
        )
      ) {
        throw new Error("Invalid OpenCode v2 model catalog")
      }
      const models = body.data.map((model) => ({
        ...model,
        providerID,
        package: responsesPackage,
      }))
      const missingImageModels = imageModels
        .filter((model) => !models.some((entry) => entry.id === model.id))
        .map(buildImageModel)
      return [...models, ...missingImageModels]
    }
    const reportError = (error) =>
      console.warn("copilot-api model discovery:", error?.message ?? error)
    let models = await loadModels().catch((error) => {
      reportError(error)
      return []
    })
    await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          id: providerID,
          name: "My Local",
          activation: "enabled",
          package: responsesPackage,
          settings: { baseURL, apiKey, compaction: { type: "native" } },
        },
        models,
      })
    })
    if (refreshIntervalMs <= 0) return
    let stopped = false
    let refreshing = false
    const refresh = async () => {
      if (stopped || refreshing) return
      refreshing = true
      try {
        const next = await loadModels()
        if (stopped) return
        models = next
        await ctx.provider.reload()
      } finally {
        refreshing = false
      }
    }
    const timer = setInterval(
      () => void refresh().catch(reportError),
      refreshIntervalMs,
    )
    return () => {
      stopped = true
      clearInterval(timer)
    }
  },
}
