import { describe, expect, test } from "bun:test"

import {
  builtinProviderModelRegistry,
  BuiltinProviderModelRegistry,
} from "~/lib/builtin-provider-models"

describe("builtin provider model registry", () => {
  test("normalizes provider and model names when resolving model config", () => {
    expect(builtinProviderModelRegistry).toBeInstanceOf(
      BuiltinProviderModelRegistry,
    )
    expect(
      builtinProviderModelRegistry.getModelConfig(
        " DeepSeek ",
        " DEEPSEEK-V4-PRO ",
      ),
    ).toMatchObject({
      contextWindow: 1_000_000,
      inputModalities: ["text"],
      maxOutputTokens: 64_000,
      pricing: {
        cachedInput: 0.3,
        input: 9,
        output: 27,
      },
    })
  })

  test("lists model ids for a normalized provider name", () => {
    const modelIds = builtinProviderModelRegistry.getModelIds(" OPENCODE-GO ")
    for (const modelId of [
      "hy3",
      "gpt-5.6-luna",
      "qwen3.8-max",
      "minimax-m3",
      "ox-alpha-free",
    ]) {
      expect(modelIds).toContain(modelId)
    }
  })

  test("defines the free Ox Alpha model with free pricing", () => {
    const config = builtinProviderModelRegistry.getModelConfig(
      "opencode-go",
      "ox-alpha-free",
    )
    expect(config).toMatchObject({
      contextWindow: 1_000_000,
      inputModalities: ["text", "image"],
      maxOutputTokens: 131_072,
      pricing: {
        cachedInput: 0,
        input: 0,
        output: 0,
      },
      reasoningEfforts: ["low", "high", "max"],
    })
  })

  test("defines the DeepSeek V4 Flash vision experimental model", () => {
    expect(
      builtinProviderModelRegistry.getModelConfig(
        "deepseek",
        "deepseek-v4-flash-vision-exp",
      ),
    ).toEqual({
      contextWindow: 1_000_000,
      inputModalities: ["text", "image"],
      maxOutputTokens: 64_000,
      pricing: {
        cachedInput: 0.1,
        input: 3,
        output: 9,
      },
    })
  })

  test("defines the supported Grok reasoning levels", () => {
    expect(
      builtinProviderModelRegistry.getModelConfig("opencode-go", "grok-4.5"),
    ).toMatchObject({
      defaultReasoningEffort: "high",
      reasoningEfforts: ["low", "medium", "high"],
    })
  })

  test("keeps GPT entries pricing-only", () => {
    expect(
      builtinProviderModelRegistry.getModelConfig("codex", "gpt-5.6-sol"),
    ).toEqual({
      pricing: {
        tiers: [
          {
            cacheCreationInput: 6.25,
            cachedInput: 0.5,
            input: 5,
            maxInputTokens: 272_000,
            output: 30,
          },
          {
            cacheCreationInput: 12.5,
            cachedInput: 1,
            input: 10,
            output: 45,
          },
        ],
      },
    })
  })

  test("returns empty results for unknown providers and models", () => {
    expect(builtinProviderModelRegistry.getModelIds("unknown")).toEqual([])
    expect(
      builtinProviderModelRegistry.getModelConfig("deepseek", "unknown"),
    ).toBeUndefined()
  })
})
