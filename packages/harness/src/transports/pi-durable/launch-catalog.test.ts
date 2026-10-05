import { expect, test } from "bun:test"
import { PI_DEFAULT_MODELS, PI_LAUNCH_PROVIDERS } from "@claxedo/agent-runtime-contract"
import { piCatalogOptions, piDefaultModel, piLaunchCatalog } from "./launch-catalog"

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
