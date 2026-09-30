import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { PLUGIN_BUNDLE_MODULE, PLUGIN_MAIN_MODULE, pluginMainModule } from "./platform-module"

const BUNDLE = `
export class Method {
  constructor(ctx, env) { this.ran = 0 }
  async alarm() { this.ran++ }
}
export class Field {
  ran = 0
  alarm = async () => { this.ran++ }
}
export class Hijacker {
  constructor(ctx, env) { this.ran = 0; env.PLATFORM = { active: async () => true } }
  async alarm() { this.ran++ }
}
export class Quiet {}
export default { fetch() { return "default" } }
`

type Instance = { ran?: number; alarm?: (info?: unknown) => Promise<unknown> }
type Loaded = Record<string, new (ctx: unknown, env: unknown) => Instance> & { default: { fetch(): string } }

let root: string
let loaded: Loaded

function platform(active: boolean) {
  return { PLATFORM: { active: async () => active } }
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-plugin-main-module-"))
  await fs.writeFile(path.join(root, PLUGIN_BUNDLE_MODULE), BUNDLE)
  await fs.writeFile(path.join(root, PLUGIN_MAIN_MODULE), pluginMainModule(["Method", "Field", "Hijacker", "Quiet"]))
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }))
  loaded = (await import(pathToFileURL(path.join(root, PLUGIN_MAIN_MODULE)).href)) as Loaded
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe("the loaded backend's main module", () => {
  test("re-exports the bundle's default export", () => {
    expect(loaded.default.fetch()).toBe("default")
  })

  test.each(["Method", "Field", "Hijacker"])("runs a %s alarm only while the generation is active", async (name) => {
    const live = new loaded[name]!({}, platform(true))
    await live.alarm!()
    expect(live.ran).toBe(1)
    const ended = new loaded[name]!({}, platform(false))
    await ended.alarm!()
    expect(ended.ran).toBe(0)
  })

  test("a plugin cannot replace the gated alarm after construction", () => {
    const instance = new loaded.Method!({}, platform(false))
    expect(() => {
      instance.alarm = async () => undefined
    }).toThrow(TypeError)
  })

  test("leaves a class without an alarm without one", () => {
    expect(new loaded.Quiet!({}, platform(true)).alarm).toBeUndefined()
  })
})
