import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { mapValues } from "remeda"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// Connected-provider coverage: make anthropic resolve as a connected provider
// so the response mixes catalog-sourced and connected-sourced entries.
process.env.ANTHROPIC_API_KEY = "test-api-key"

// Built through the shared memoMap (`testEffectShared`) so `Provider.Service`
// resolved in the test body is the SAME instance the in-process HTTP server
// uses — required to observe that the handler serves `Provider.State.catalog`.
const providerNodes = LayerNode.compile(
  LayerNode.group([
    Provider.node,
    FSUtil.node,
    Env.node,
    Config.node,
    Auth.node,
    Plugin.node,
    ModelsDev.node,
    RuntimeFlags.node,
  ]),
)

const it = testEffectShared(Layer.mergeAll(httpApiLayer, providerNodes))
const projectOptions = { config: { formatter: false, lsp: false } }

afterEach(async () => {
  await disposeAllInstances()
})

describe("provider HttpApi catalog reuse", () => {
  it.instance(
    "GET /provider serves catalog-sourced entries from Provider.State.catalog, not a fresh derivation",
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const catalog = yield* Provider.use.catalog()
      const connected = yield* Provider.use.list()
      const id = Object.keys(catalog).find((key) => !(key in connected))
      expect(id).toBeDefined()
      const entry = catalog[id as keyof typeof catalog]
      const original = entry.name
      entry.name = "__catalog-is-source-of-truth__"
      try {
        const response = yield* requestInDirectory("/provider", directory)
        expect(response.status).toBe(200)
        const body = (yield* response.json) as { all: { id: string; name: string }[] }
        const served = body.all.find((item) => item.id === id)
        expect(served?.name).toBe("__catalog-is-source-of-truth__")
      } finally {
        entry.name = original
      }
    }),
    projectOptions,
    30000,
  )

  it.instance(
    "GET /provider body is byte-identical to the previous per-request derivation",
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      // Force instance init through the same service instance the server uses.
      const connected = yield* Provider.use.list()
      const all = yield* ModelsDev.Service.use((s) => s.get())
      // The exact derivation GET /provider performed before catalog reuse:
      // re-walk models.dev via fromModelsDevProvider, overlay connected
      // providers, then clone every entry through toPublicInfo.
      const providers = Object.assign(
        mapValues(all, (item) => Provider.fromModelsDevProvider(item)),
        connected,
      )
      const expected = {
        all: Object.values(providers).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
        connected: Object.keys(connected),
      }
      const encoded = yield* Schema.encodeUnknownEffect(Provider.ListResult)(expected)
      const expectedBody = JSON.stringify(encoded)

      const response = yield* requestInDirectory("/provider", directory)
      expect(response.status).toBe(200)
      const actualBody = yield* response.text
      expect(actualBody.length).toBe(expectedBody.length)
      expect(actualBody).toBe(expectedBody)
    }),
    projectOptions,
    30000,
  )
})
