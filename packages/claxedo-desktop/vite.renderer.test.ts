import { afterEach, describe, expect, test } from "bun:test"
import { createElectronRenderer, diagnosticSubtractionManifestPlugin } from "./vite.renderer"
import { resolveSubtractionManifest } from "../claxedo-app/src/platform/performance/subtraction"

const envKey = "VITE_CLAXEDO_SUBTRACTION_OWNER"

afterEach(() => {
  delete process.env[envKey]
})

describe("desktop diagnostic subtraction build", () => {
  test("ordinary builds compile the unchanged control and emit no diagnostic manifest", () => {
    delete process.env[envKey]
    const config = createElectronRenderer("production")
    expect(config.define?.__CLAXEDO_SUBTRACTION_OWNER__).toBe("null")
    expect(config.plugins?.flat().map((plugin) => plugin && typeof plugin === "object" && "name" in plugin ? plugin.name : undefined))
      .not.toContain("claxedo-diagnostic-subtraction-manifest")
  })

  test("a diagnostic owner becomes one compile-time scalar and one stable manifest", () => {
    process.env[envKey] = "terminal"
    const config = createElectronRenderer("performance-diagnostic")
    expect(config.define?.__CLAXEDO_SUBTRACTION_OWNER__).toBe('"terminal"')

    const manifest = resolveSubtractionManifest({ mode: "performance-diagnostic", owner: "terminal" })
    const plugin = diagnosticSubtractionManifestPlugin(manifest)
    const assets: unknown[] = []
    plugin.generateBundle.call({ emitFile: (asset: unknown) => assets.push(asset) })
    expect(assets).toEqual([{
      type: "asset",
      fileName: "claxedo-diagnostic-subtraction.json",
      source: '{\n  "schema": 1,\n  "diagnosticOnly": true,\n  "variant": "without-terminal",\n  "owner": "terminal"\n}\n',
    }])
  })

  test("rejects a diagnostic owner from a release build", () => {
    process.env[envKey] = "app"
    expect(() => createElectronRenderer("production")).toThrow("requires --mode performance-diagnostic")
  })
})
