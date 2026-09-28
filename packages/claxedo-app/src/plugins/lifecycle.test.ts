import { describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import type { Activation } from "./activation"
import { createPluginLifecycle } from "./lifecycle"
import type { PluginBuild } from "./model"

const build: PluginBuild = {
  manifest: { id: "fixture", name: "Fixture", version: "0.1.0", app: "./app.tsx", requires: [], server: { routes: [], operations: [] } },
  origin: { hash: "a".repeat(16), directory: "/tmp/fixture" },
  definition: { activate: () => undefined },
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe("a plugin's lifecycle", () => {
  test("a second change while a build is starting does not activate that build again", async () => {
    const [switches, setSwitches] = createSignal({ on: true })
    const pending: ((activation: Activation) => void)[] = []
    const disposed: string[] = []
    const lifecycle = createPluginLifecycle(
      build,
      () => switches().on,
      () => new Promise<Activation>((resolve) => pending.push(resolve)),
    )
    await settle()
    setSwitches({ on: true })
    await settle()
    expect(pending).toHaveLength(1)
    pending[0]({ build: build.origin.hash, dispose: () => disposed.push("first") })
    await settle()
    expect(lifecycle.state()).toEqual({ kind: "on", build: "a".repeat(16) })
    expect(disposed).toEqual([])
    lifecycle.dispose()
    expect(disposed).toEqual(["first"])
  })
})
