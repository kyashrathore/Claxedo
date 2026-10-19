/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { CatalogProvider } from "@/server"
import { cloudModelOffer } from "./cloud-catalog-models"
import { cloudConfiguration, cloudDefaultModel, isCloudDefaultModel } from "./cloud-model"
import { rebaseConfiguration } from "./model"

test("a harness whose models only a running workspace lists runs on its own default in a new cloud workspace", () => {
  expect(cloudDefaultModel({ id: "claude", access: "native" })).toEqual({ providerID: "claude", modelID: "default" })
  expect(cloudDefaultModel({ id: "codex", access: "native" })).toEqual({ providerID: "codex", modelID: "default" })
  expect(cloudDefaultModel({ id: "cursor", access: "native" })).toEqual({ providerID: "cursor", modelID: "auto" })
  expect(cloudDefaultModel({ id: "opencode", access: "native" })).toBeUndefined()
  expect(isCloudDefaultModel(cloudConfiguration({ id: "claude", access: "native" }))).toBe(true)
  expect(isCloudDefaultModel({ harness: { id: "claude", access: "native" }, model: { providerID: "claude", modelID: "claude-haiku-4-5-20251001" }, effort: null })).toBe(false)
})

test("switching harness drops the model and effort the picker carried over, and keeps a model chosen with the new harness", () => {
  const claude = { harness: { id: "claude", access: "native" }, model: { providerID: "anthropic", modelID: "opus" }, effort: "high" } as const
  expect(rebaseConfiguration(claude, { ...claude, harness: { id: "opencode", access: "native" } })).toEqual({ harness: { id: "opencode", access: "native" }, model: null, effort: null })
  const chosen = { harness: { id: "opencode", access: "native" }, model: { providerID: "openai", modelID: "gpt-5" }, effort: null } as const
  expect(rebaseConfiguration(claude, chosen)).toEqual(chosen)
  expect(rebaseConfiguration(claude, { ...claude, effort: "low" })).toEqual({ ...claude, effort: "low" })
})

const catalog = (connected: readonly string[], openai: Partial<CatalogProvider> = {}): { all: CatalogProvider[]; connected: readonly string[] } => ({
  all: [
    { id: "anthropic", name: "Anthropic", source: "api", models: { "claude-opus-4-8": { id: "claude-opus-4-8", name: "Claude Opus 4.8", connected: true } } },
    { id: "openai", name: "OpenAI", source: "api", models: { "gpt-5.6-sol": { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", connected: true } }, ...openai },
    { id: "groq", name: "Groq", models: {} },
  ],
  connected,
})

test("cloud OpenCode offers the models of the providers the person holds an account for, in OpenCode's provider/model ids", () => {
  expect(cloudModelOffer(catalog(["anthropic", "openai"]))).toEqual({ planUnlisted: false, choices: [
    { model: { providerID: "anthropic", modelID: "claude-opus-4-8" }, provider: "Anthropic", name: "Claude Opus 4.8" },
    { model: { providerID: "openai", modelID: "gpt-5.6-sol" }, provider: "OpenAI", name: "GPT-5.6 Sol" },
  ] })
  expect(cloudModelOffer(catalog(["anthropic"])).choices.map((choice) => choice.model.providerID)).toEqual(["anthropic"])
})

test("with no account OpenCode can use, a cloud configuration has no model to offer", () => {
  expect(cloudModelOffer(catalog([]))).toEqual({ choices: [], planUnlisted: false })
})

test("OpenAI reached only through a ChatGPT plan offers no model in a cloud configuration and says so", () => {
  const plan = catalog(["anthropic", "openai"], { source: "harness", harness: "codex", models: {} })
  expect(cloudModelOffer(plan).choices.map((choice) => choice.model.providerID)).toEqual(["anthropic"])
  expect(cloudModelOffer(plan).planUnlisted).toBe(true)
  expect(cloudModelOffer(catalog(["openai"], { source: "harness", harness: "codex", models: {} }))).toEqual({ choices: [], planUnlisted: true })
})
