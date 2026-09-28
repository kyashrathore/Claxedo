import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createOpenCodeRuntime } from "./runtime"
import { WorkspaceScope } from "./scope"

test("provider policy updates the real SDK catalog, is workspace-scoped, and survives reopening", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-provider-policy-"))
  const options = {
    databasePath: path.join(root, "opencode.db"),
    configContent: JSON.stringify({
      providers: {
        claxedo_test: { name: "Test", package: "@ai-sdk/openai-compatible", models: { test: { name: "Test model" } } },
      },
    }),
  }
  const a = path.join(root, "a")
  const b = path.join(root, "b")
  fs.mkdirSync(a)
  fs.mkdirSync(b)
  const scopeA = WorkspaceScope.authorize({ workspaceID: "a", directory: a })
  const scopeB = WorkspaceScope.authorize({ workspaceID: "b", directory: b })
  let runtime = createOpenCodeRuntime(options)
  const ids = async (scope: typeof scopeA) => (await runtime.catalog.models(scope)).map((model) => model.providerID)
  try {
    expect(await ids(scopeA)).toContain("claxedo_test")
    const policy = await runtime.providerConfig(scopeA)
    await policy.write({ disabled_providers: ["claxedo_test"] })
    expect(await ids(scopeA)).not.toContain("claxedo_test")
    expect(await ids(scopeB)).toContain("claxedo_test")
    await runtime.close()
    runtime = createOpenCodeRuntime(options)
    expect(await ids(scopeA)).not.toContain("claxedo_test")
    const reopened = await runtime.providerConfig(scopeA)
    expect(await reopened.read()).toEqual({ disabled_providers: ["claxedo_test"] })
    await reopened.write({ disabled_providers: [] })
    expect(await ids(scopeA)).toContain("claxedo_test")
    const disable = reopened.write({ disabled_providers: ["claxedo_test"] })
    const disabledSnapshot = reopened.read()
    const enable = reopened.write({ disabled_providers: [] })
    expect(await disable).toEqual({ disabled_providers: ["claxedo_test"] })
    expect(await disabledSnapshot).toEqual({ disabled_providers: ["claxedo_test"] })
    expect(await enable).toEqual({ disabled_providers: [] })
    expect(await reopened.read()).toEqual({ disabled_providers: [] })
  } finally {
    await runtime.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 20_000)

test("a provider the workspace policy disabled stays disabled when a binding names it, across a rebind", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-provider-policy-binding-"))
  const directory = path.join(root, "work")
  fs.mkdirSync(directory)
  const scope = WorkspaceScope.authorize({ workspaceID: "w", directory })
  const runtime = createOpenCodeRuntime({ databasePath: path.join(root, "opencode.db") })
  const openai = async () => (await runtime.catalog.models(scope)).some((model) => model.providerID === "openai")
  try {
    await runtime.bindProviders({ overlays: { openai: { baseURL: "http://127.0.0.1:1/v1", apiKey: "first" } }, unbound: "disabled" })
    expect(await openai()).toBe(true)
    await (await runtime.providerConfig(scope)).write({ disabled_providers: ["openai"] })
    expect(await openai()).toBe(false)
    await runtime.bindProviders({ overlays: { openai: { baseURL: "http://127.0.0.1:1/v1", apiKey: "second" } }, unbound: "disabled" })
    expect(await openai()).toBe(false)
  } finally {
    await runtime.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
