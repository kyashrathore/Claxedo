import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createOpenCodeRuntime } from "./runtime"
import { WorkspaceScope } from "./scope"

/**
 * What the engine does with an account the operator chose and the broker will
 * not serve.
 *
 * Sending nothing is indistinguishable from "no account chosen", which the
 * engine answers by running the turn on its own login — the one outcome the
 * selection exists to prevent.
 */
function engine() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-provider-binding-"))
  const directory = path.join(root, "work")
  fs.mkdirSync(directory)
  const runtime = createOpenCodeRuntime({
    databasePath: path.join(root, "opencode.db"),
    configContent: JSON.stringify({
      providers: {
        claxedo_test: { name: "Test", package: "@ai-sdk/openai-compatible", models: { test: { name: "Test model" } } },
      },
    }),
  })
  return {
    runtime,
    scope: WorkspaceScope.authorize({ workspaceID: "w", directory }),
    close: async () => {
      await runtime.close()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

test("an unavailable account disables its provider in the engine's own catalog", async () => {
  const { runtime, scope, close } = engine()
  const providerIds = async () => (await runtime.catalog.models(scope)).map((model) => model.providerID)
  try {
    expect(await providerIds()).toContain("claxedo_test")

    await runtime.bindProviders({ claxedo_test: { unavailable: true, reason: "auth_failed" } })

    expect(await providerIds()).not.toContain("claxedo_test")
    expect(runtime.providerUnavailableReason("claxedo_test")).toBe("auth_failed")
  } finally {
    await close()
  }
}, 20_000)

test("a bound account routes that provider at the broker and leaves it selectable", async () => {
  const { runtime, scope, close } = engine()
  try {
    await runtime.bindProviders({
      claxedo_test: { baseURL: "http://127.0.0.1:2595/bindings/b1/v1", apiKey: "placeholder" },
    })

    expect((await runtime.catalog.models(scope)).map((model) => model.providerID)).toContain("claxedo_test")
    expect(runtime.providerUnavailableReason("claxedo_test")).toBeUndefined()
  } finally {
    await close()
  }
}, 20_000)

test("a provider nobody bound keeps the engine's own auth", async () => {
  const { runtime, scope, close } = engine()
  try {
    await runtime.bindProviders({})

    expect((await runtime.catalog.models(scope)).map((model) => model.providerID)).toContain("claxedo_test")
    expect(runtime.providerUnavailableReason("claxedo_test")).toBeUndefined()
  } finally {
    await close()
  }
}, 20_000)
