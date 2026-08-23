import { builtinProviderModelRegistry } from "../builtin-provider-models"
import {
  normalizeToken,
  type TokenUsageSource,
  type UsageTokens,
} from "./store"

export interface TokenUsagePricingTier {
  cachedInput?: number
  cacheCreationInput?: number
  explicitCachedInput?: number
  input?: number
  maxInputTokens?: number
  output?: number
}

export interface TokenUsagePricingConfig extends TokenUsagePricingTier {
  tiers?: Array<TokenUsagePricingTier>
}

export interface CalculatedTokenUsageCost {
  currency: string
  source: string
  total_cost_nanos: number
}

interface TokenUsageCostInput extends UsageTokens {
  model: string
  pricing?: TokenUsagePricingConfig | null
  pricingCurrency?: string | null
  providerName?: string | null
  source: TokenUsageSource
}

interface ResolvedPricing {
  pricing: TokenUsagePricingConfig
  source: string
}

const COST_NANOS_PER_UNIT = 1_000_000_000
const COST_NANOS_PER_TOKEN_AT_ONE_PER_MILLION = 1_000
const COPILOT_NANO_AIU_PER_USD = 100_000_000_000
const COPILOT_NANO_AIU_TO_COST_NANOS =
  COST_NANOS_PER_UNIT / COPILOT_NANO_AIU_PER_USD
const BUILTIN_PROVIDER_CURRENCIES: Record<string, string> = {
  codex: "USD",
  dashscope: "CNY",
  deepseek: "CNY",
  kimi: "USD",
  "opencode-go": "USD",
}

export function resolveTokenUsageCost(
  input: TokenUsageCostInput,
): CalculatedTokenUsageCost | null {
  if (
    input.source === "provider"
    && input.providerName?.trim().toLowerCase() === "openrouter"
  ) {
    const reportedCost = resolveReportedProviderCost(input)
    if (reportedCost) {
      return reportedCost
    }
  }

  if (input.source === "copilot") {
    return resolveCopilotCost(input)
  }

  const providerName = input.providerName?.trim()
  if (!providerName) {
    return null
  }

  const resolvedPricing = resolveProviderPricing(
    providerName,
    input.model,
    input.pricing,
  )
  if (!resolvedPricing) {
    return null
  }

  const pricing = resolvePricingTier(
    resolvedPricing.pricing,
    getInputTokenTotal(input),
  )
  const currency = resolveProviderCurrency(providerName, input.pricingCurrency)
  if (!currency) {
    return null
  }

  const inputPrice = normalizePrice(pricing.input)
  const outputPrice = normalizePrice(pricing.output)
  const cacheReadPrice = resolveCacheReadPrice(pricing, input)
  const cacheCreationPrice = resolveCacheCreationPrice(pricing)

  const totalCostNanos =
    costNanosForTokens(input.input_tokens, inputPrice)
    + costNanosForTokens(input.output_tokens, outputPrice)
    + costNanosForTokens(input.cache_read_input_tokens, cacheReadPrice)
    + costNanosForTokens(input.cache_creation_input_tokens, cacheCreationPrice)

  if (totalCostNanos <= 0) {
    return null
  }

  return {
    currency,
    source: resolvedPricing.source,
    total_cost_nanos: totalCostNanos,
  }
}

function resolveReportedProviderCost(
  input: TokenUsageCostInput,
): CalculatedTokenUsageCost | null {
  const cost = normalizePrice(input.cost)
  if (cost === null) {
    return null
  }

  const totalCostNanos = Math.round(cost * COST_NANOS_PER_UNIT)
  if (totalCostNanos < 0) {
    return null
  }

  return {
    currency: "USD",
    source: "upstream",
    total_cost_nanos: totalCostNanos,
  }
}

export function getCostAmount(totalCostNanos: number): number {
  return totalCostNanos / COST_NANOS_PER_UNIT
}

function resolveCopilotCost(
  input: TokenUsageCostInput,
): CalculatedTokenUsageCost | null {
  const totalNanoAiu = normalizeToken(input.total_nano_aiu)
  if (totalNanoAiu <= 0) {
    return null
  }

  const totalCostNanos = Math.round(
    totalNanoAiu * COPILOT_NANO_AIU_TO_COST_NANOS,
  )
  if (totalCostNanos <= 0) {
    return null
  }

  return {
    currency: "USD",
    source: "copilot_aiu",
    total_cost_nanos: totalCostNanos,
  }
}

function resolveProviderPricing(
  providerName: string,
  model: string,
  configuredPricing: TokenUsagePricingConfig | null | undefined,
): ResolvedPricing | null {
  if (configuredPricing) {
    return {
      pricing: configuredPricing,
      source: "config",
    }
  }

  const builtinPricing = builtinProviderModelRegistry.getModelConfig(
    providerName,
    model,
  )?.pricing
  if (!builtinPricing) {
    return null
  }

  return {
    pricing: builtinPricing,
    source: "builtin",
  }
}

function resolvePricingTier(
  pricing: TokenUsagePricingConfig,
  inputTokenTotal: number,
): TokenUsagePricingTier {
  const tiers = pricing.tiers
    ?.filter((tier) => typeof tier === "object" && tier !== null)
    .toSorted((a, b) => normalizeTierMax(a) - normalizeTierMax(b))

  const selectedTier =
    tiers?.find((tier) => inputTokenTotal <= normalizeTierMax(tier))
    ?? tiers?.at(-1)

  return {
    ...pricing,
    ...selectedTier,
  }
}

function normalizeTierMax(tier: TokenUsagePricingTier): number {
  const maxInputTokens = tier.maxInputTokens
  return (
      typeof maxInputTokens === "number"
        && Number.isFinite(maxInputTokens)
        && maxInputTokens > 0
    ) ?
      maxInputTokens
    : Number.POSITIVE_INFINITY
}

function getInputTokenTotal(input: UsageTokens): number {
  return (
    normalizeToken(input.input_tokens)
    + normalizeToken(input.cache_read_input_tokens)
    + normalizeToken(input.cache_creation_input_tokens)
  )
}

function normalizePrice(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ?
      value
    : null
}

function resolveProviderCurrency(
  providerName: string,
  configuredCurrency: string | null | undefined,
): string | null {
  const currency =
    configuredCurrency?.trim().toUpperCase()
    || BUILTIN_PROVIDER_CURRENCIES[providerName.toLowerCase()]
  return currency || null
}

function resolveCacheCreationPrice(
  pricing: TokenUsagePricingTier,
): number | null {
  return normalizePrice(pricing.cacheCreationInput)
}

function resolveCacheReadPrice(
  pricing: TokenUsagePricingTier,
  input: UsageTokens,
): number | null {
  const hasCacheCreationSignal =
    input.cache_creation_input_tokens !== undefined
    && input.cache_creation_input_tokens !== null

  if (hasCacheCreationSignal) {
    const explicitPrice = normalizePrice(pricing.explicitCachedInput)
    if (explicitPrice !== null) {
      return explicitPrice
    }
  }

  return normalizePrice(pricing.cachedInput)
}

function costNanosForTokens(
  tokens: number | null | undefined,
  pricePerMillionTokens: number | null,
): number {
  if (pricePerMillionTokens === null) {
    return 0
  }

  return Math.round(
    normalizeToken(tokens)
      * pricePerMillionTokens
      * COST_NANOS_PER_TOKEN_AT_ONE_PER_MILLION,
  )
}
