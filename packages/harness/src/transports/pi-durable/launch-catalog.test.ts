import { expect, test } from "bun:test"
import { PI_DEFAULT_MODELS, PI_LAUNCH_PROVIDERS } from "@claxedo/agent-runtime-contract"
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic"
import { googleProvider } from "@earendil-works/pi-ai/providers/google"
import { groqProvider } from "@earendil-works/pi-ai/providers/groq"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex"
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter"
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai"
import { piCatalogModel, piCatalogOptions, piDefaultModel, piLaunchCatalog } from "./launch-catalog"

test("the launch catalog offers exactly the models each built-in Pi provider answers", () => {
  const providers = {
    "openai-codex": openaiCodexProvider, anthropic: anthropicProvider, openai: openaiProvider, openrouter: openrouterProvider,
    google: googleProvider, groq: groqProvider, xai: xaiProvider,
  }
  for (const provider of PI_LAUNCH_PROVIDERS) {
    const offered = providers[provider]().getModels().map((model) => piCatalogModel(provider, model))
    expect(offered.length).toBeGreaterThan(0)
    expect(piLaunchCatalog([provider])).toEqual(offered)
  }
})

test("every provider's default model is one Pi's own catalog offers", () => {
  for (const provider of PI_LAUNCH_PROVIDERS) {
    const id = PI_DEFAULT_MODELS[provider]
    if (id) expect(piLaunchCatalog([provider]).map((row) => row.id)).toContain(`${provider}/${id}`)
  }
})

test("a Pi draft with no model starts on the first connected provider's newest model, and a chosen model stays chosen", () => {
  const models = piLaunchCatalog(["openai-codex", "anthropic"])
  expect(models[0]?.id).toBe("openai-codex/gpt-5.3-codex-spark")
  expect(piDefaultModel(models)?.id).toBe("openai-codex/gpt-6.1-sol")
  expect(piDefaultModel(piLaunchCatalog(["anthropic"]))?.id).toBe("anthropic/claude-opus-5-5")
  const current = (preview: ReturnType<typeof piCatalogOptions>) => preview.resolvedModel?.id
  expect(current(piCatalogOptions(models))).toBe("openai-codex/gpt-6.1-sol")
  expect(current(piCatalogOptions(models, "anthropic/claude-sonnet-5"))).toBe("anthropic/claude-sonnet-5")
})
