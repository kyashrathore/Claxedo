/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { CatalogProvider } from "@/server"
import { cloudModelOffer } from "./cloud-catalog-models"
import { cloudConfiguration, cloudPresetModel } from "./cloud-model"
import { cloudHarnessProblem, emptyPresetEditorDraft, parsePresetEditorDraft, type ConfigurationDraft } from "./draft"

function cloudDraft(primary: ConfigurationDraft) {
  const empty = emptyPresetEditorDraft()
  return { ...empty, name: "Cloud review", placement: "cloud" as const, configurations: { ...empty.configurations, primary } }
}

test("a cloud preset runs a harness whose models only a running workspace lists on the harness's own default", () => {
  expect(cloudPresetModel({ id: "claude", access: "native" })).toEqual({ providerID: "claude", modelID: "default" })
  expect(cloudPresetModel({ id: "codex", access: "native" })).toEqual({ providerID: "codex", modelID: "default" })
  expect(cloudPresetModel({ id: "cursor", access: "native" })).toEqual({ providerID: "cursor", modelID: "auto" })
  expect(cloudPresetModel({ id: "opencode", access: "native" })).toBeUndefined()
})

test("choosing Claude Code or Codex for a cloud preset saves it on that default, with no workspace asked", () => {
  for (const id of ["claude", "codex"]) {
    const parsed = parsePresetEditorDraft(cloudDraft(cloudConfiguration({ id, access: "native" })))
    expect(parsed).toMatchObject({
      ok: true,
      draft: {
        execution: { placement: "cloud" },
        configurations: { primary: { harness: { id }, model: { providerID: id, modelID: "default" }, effort: null } },
      },
    })
  }
})

test("a cloud OpenCode configuration asks for a model and saves the one chosen", () => {
  const opencode = { id: "opencode", access: "native" } as const
  const unchosen = cloudDraft(cloudConfiguration(opencode))
  expect(cloudHarnessProblem(unchosen, "primary")).toBeUndefined()
  expect(parsePresetEditorDraft(unchosen)).toMatchObject({ ok: false, fields: { "configurations.primary.model": { key: "tasks.preset.chooseModel" } } })
  const chosen: ConfigurationDraft = { harness: opencode, model: { providerID: "anthropic", modelID: "claude-opus-4-8" }, effort: null }
  expect(parsePresetEditorDraft(cloudDraft(chosen))).toMatchObject({ ok: true, draft: { configurations: { primary: chosen } } })
})

const catalog = (connected: readonly string[], openai: Partial<CatalogProvider> = {}): { all: CatalogProvider[]; connected: readonly string[] } => ({
  all: [
    { id: "anthropic", name: "Anthropic", source: "api", models: { "claude-opus-4-8": { id: "claude-opus-4-8", name: "Claude Opus 4.8", connected: true } } },
    { id: "openai", name: "OpenAI", source: "api", models: { "gpt-5.6-sol": { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", connected: true } }, ...openai },
    { id: "groq", name: "Groq", models: {} },
  ],
  connected,
})

test("a cloud OpenCode preset offers the models of the providers the person holds an account for, in OpenCode's provider/model ids", () => {
  expect(cloudModelOffer(catalog(["anthropic", "openai"]))).toEqual({ planUnlisted: false, choices: [
    { model: { providerID: "anthropic", modelID: "claude-opus-4-8" }, provider: "Anthropic", name: "Claude Opus 4.8" },
    { model: { providerID: "openai", modelID: "gpt-5.6-sol" }, provider: "OpenAI", name: "GPT-5.6 Sol" },
  ] })
  expect(cloudModelOffer(catalog(["anthropic"])).choices.map((choice) => choice.model.providerID)).toEqual(["anthropic"])
})

test("with no account OpenCode can use, a cloud preset has no model to offer", () => {
  expect(cloudModelOffer(catalog([]))).toEqual({ choices: [], planUnlisted: false })
})

test("OpenAI reached only through a ChatGPT plan offers no model in a cloud preset and says so", () => {
  const plan = catalog(["anthropic", "openai"], { source: "harness", harness: "codex", models: {} })
  expect(cloudModelOffer(plan).choices.map((choice) => choice.model.providerID)).toEqual(["anthropic"])
  expect(cloudModelOffer(plan).planUnlisted).toBe(true)
  expect(cloudModelOffer(catalog(["openai"], { source: "harness", harness: "codex", models: {} }))).toEqual({ choices: [], planUnlisted: true })
})

test("a cloud configuration keeps a model it was saved with", () => {
  const saved: ConfigurationDraft = {
    harness: { id: "claude", access: "native" },
    model: { providerID: "claude", modelID: "claude-haiku-4-5-20251001" },
    effort: null,
  }
  expect(cloudHarnessProblem(cloudDraft(saved), "primary")).toBeUndefined()
  expect(parsePresetEditorDraft(cloudDraft(saved))).toMatchObject({ ok: true, draft: { configurations: { primary: saved } } })
})
