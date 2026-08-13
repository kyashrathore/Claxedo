import { expect, test } from "bun:test"
import { makeLazyDatabase, toPublicInfo, type Info } from "@/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const provider = (id: string, env: string[]): Info => ({
  id: ProviderV2.ID.make(id),
  source: "custom",
  name: id,
  env,
  options: {},
  models: {
    "model-a": {
      id: ModelV2.ID.make("model-a"),
      providerID: ProviderV2.ID.make(id),
      name: "Model A",
      family: "",
      api: { id: "model-a", url: "https://api.example.com", npm: "@ai-sdk/openai-compatible" },
      status: "active",
      headers: {},
      options: {},
      cost: { input: 1, output: 2, cache: { read: 0, write: 0 } },
      limit: { context: 200000, input: undefined, output: 8192 },
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      release_date: "2024-01-01",
      variants: {},
    },
  },
})

const catalog = () => ({
  connected: provider("connected", ["CONNECTED_API_KEY"]),
  unconnected: provider("unconnected", ["UNCONNECTED_API_KEY"]),
})

const counting = () => {
  const cloned: string[] = []
  const clone = (info: Info) => {
    cloned.push(info.id)
    return toPublicInfo(info)
  }
  return { cloned, clone }
}

test("constructing the database clones nothing", () => {
  const { cloned, clone } = counting()
  makeLazyDatabase(catalog(), clone)
  expect(cloned).toEqual([])
})

test("clone is taken on first get only, and only for the provider asked for", () => {
  const { cloned, clone } = counting()
  const db = makeLazyDatabase(catalog(), clone)
  const first = db.get("connected")
  const second = db.get("connected")
  expect(first).toBeDefined()
  expect(second).toBe(first!)
  expect(cloned).toEqual(["connected"])
})

test("get for an unknown provider returns undefined without cloning", () => {
  const { cloned, clone } = counting()
  const db = makeLazyDatabase(catalog(), clone)
  expect(db.get("nope")).toBeUndefined()
  expect(cloned).toEqual([])
})

test("the env scan pattern (ids + peek) never clones an unconnected provider", () => {
  // Mirrors the initializer's env scan: iterate every provider id, read only
  // `.env`, then merge (get) exclusively the providers whose key is present.
  const { cloned, clone } = counting()
  const db = makeLazyDatabase(catalog(), clone)
  const envs: Record<string, string> = { CONNECTED_API_KEY: "sk-test" }
  for (const id of db.ids()) {
    const info = db.peek(id)!
    const apiKey = info.env.map((item) => envs[item]).find(Boolean)
    if (!apiKey) continue
    db.get(id)
  }
  expect(cloned).toEqual(["connected"])
})

test("get returns a private clone: mutations never reach the catalog", () => {
  const source = catalog()
  const db = makeLazyDatabase(source)
  const copy = db.get("connected")!
  expect(copy).not.toBe(source.connected)
  copy.models["model-a"].status = "deprecated"
  delete copy.models["model-a"]
  copy.options["mutated"] = true
  expect(source.connected.models["model-a"].status).toBe("active")
  expect(source.connected.options).toEqual({})
})

test("get observes entries stored with set, without cloning", () => {
  const { cloned, clone } = counting()
  const db = makeLazyDatabase(catalog(), clone)
  const parsed = provider("from-config", [])
  db.set("from-config", parsed)
  expect(db.get("from-config")).toBe(parsed)
  expect(db.peek("from-config")).toBe(parsed)
  expect(cloned).toEqual([])
})

test("set overrides a catalog entry for later get and peek", () => {
  const db = makeLazyDatabase(catalog())
  const replacement = provider("connected", ["OTHER_KEY"])
  db.set("connected", replacement)
  expect(db.get("connected")).toBe(replacement)
  expect(db.peek("connected")!.env).toEqual(["OTHER_KEY"])
})

test("ids lists catalog ids in catalog order, then set-only ids in insertion order", () => {
  const db = makeLazyDatabase(catalog())
  db.get("unconnected")
  db.set("zeta", provider("zeta", []))
  db.set("alpha", provider("alpha", []))
  expect(db.ids()).toEqual(["connected", "unconnected", "zeta", "alpha"])
})

test("clone output matches the eager toPublicInfo pass for every provider", () => {
  // Preservation harness: for a catalogue with both connected and unconnected
  // providers, materializing everything lazily is deep-equal to the eager
  // `mapValues(catalog, toPublicInfo)` database this replaced.
  const source = catalog()
  const db = makeLazyDatabase(source)
  const eager = Object.fromEntries(Object.entries(source).map(([id, info]) => [id, toPublicInfo(info)]))
  const lazy = Object.fromEntries(db.ids().map((id) => [id, db.get(id)]))
  expect(lazy).toEqual(eager)
})
