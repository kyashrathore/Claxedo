import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Npm } from "@opencode-ai/core/npm"
import path from "path"
import { pathToFileURL } from "url"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin/index"

import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

// `Plugin.state` reads the budget from the flags captured when its layer is built, so each
// budget needs its own harness.
function harness(pluginInitTimeoutMs: number) {
  return testEffect(
    AppNodeBuilder.build(LayerNode.group([Plugin.node, CrossSpawnSpawner.node]), [
      [Auth.node, AuthTest.empty],
      [Account.node, AccountTest.empty],
      [Npm.node, NpmTest.noop],
      [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true, pluginInitTimeoutMs })],
    ]),
  )
}

// Small budget so the deadline tests are fast; the production default lives in src/plugin/index.ts.
const BUDGET_MS = 120
const bounded = harness(BUDGET_MS)
// Budget large enough that it never fires, so these tests measure construction only.
const generous = harness(30_000)
// Budget that a few ordinary plugins can exhaust between them.
const SUM_BUDGET_MS = 300
const sum = harness(SUM_BUDGET_MS)

const systemHook = "experimental.chat.system.transform"

/** Writes plugin sources into the test instance and points opencode.json at them, in order. */
function withPlugins<A, E, R>(sources: string[], self: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const test = yield* TestInstance
    const files = sources.map((_, index) => path.join(test.directory, `plugin-${index}.ts`))
    yield* Effect.forEach(sources, (source, index) => Effect.promise(() => Bun.write(files[index]!, source)), {
      discard: true,
      concurrency: "unbounded",
    })
    yield* Effect.promise(() =>
      Bun.write(
        path.join(test.directory, "opencode.json"),
        JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: files.map((f) => pathToFileURL(f).href) }),
      ),
    )
    return yield* self
  })
}

/** A plugin whose constructor takes `delayMs` and whose hook appends `marker`. */
function markerPlugin(marker: string, delayMs = 0) {
  return [
    "export default async () => {",
    delayMs > 0 ? `  await new Promise((resolve) => setTimeout(resolve, ${delayMs}))` : "",
    "  return {",
    `    ${JSON.stringify(systemHook)}: (_input, output) => {`,
    `      output.system.push(${JSON.stringify(marker)})`,
    "    },",
    "  }",
    "}",
    "",
  ].join("\n")
}

/** A plugin whose constructor never settles. */
const hungPlugin = ["export default async () => new Promise(() => {})", ""].join("\n")

const markers = Effect.fn("PluginInitBudgetTest.markers")(function* () {
  const plugin = yield* Plugin.Service
  const out = { system: [] as string[] }
  yield* plugin.trigger(
    systemHook,
    { model: { providerID: ProviderV2.ID.anthropic, modelID: ModelV2.ID.make("claude-sonnet-4-6") } },
    out,
  )
  return out.system
})

/** Polls `markers()` until `predicate` holds or `timeoutMs` elapses. */
const waitForMarkers = Effect.fn("PluginInitBudgetTest.waitForMarkers")(function* (
  predicate: (value: string[]) => boolean,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs
  let latest = yield* markers()
  while (!predicate(latest) && Date.now() < deadline) {
    yield* Effect.promise(() => Bun.sleep(10))
    latest = yield* markers()
  }
  return latest
})

describe("plugin init budget", () => {
  bounded.instance(
    "a plugin whose constructor never resolves does not block boot",
    () =>
      // Construction is sequential, so the hung plugin is placed last: plugins ordered after a
      // hung one still cannot run. The budget bounds what *boot* pays, not the plugin itself.
      withPlugins(
        [markerPlugin("ready"), hungPlugin],
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          const started = Date.now()
          yield* plugin.init()
          const elapsed = Date.now() - started

          // Without a budget `init` never returns; this bound is the observable proof.
          expect(elapsed).toBeLessThan(5_000)
          // The well-behaved plugin is registered and boot is usable.
          expect(yield* markers()).toEqual(["ready"])
        }),
      ),
    15_000,
  )

  bounded.instance(
    "a plugin that resolves after the budget still registers its hooks",
    () =>
      withPlugins(
        [markerPlugin("slow", BUDGET_MS * 10)],
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          yield* plugin.init()

          // The budget fired: boot completed without waiting for the slow plugin.
          expect(yield* markers()).toEqual([])

          // Deferred, not dropped: the hooks register once the constructor settles.
          expect(yield* waitForMarkers((value) => value.length > 0, 10_000)).toEqual(["slow"])
        }),
      ),
    20_000,
  )

  // Construction stays sequential (see plugin.loader.shared > "initializes server plugins in
  // config order"), so several plugins add up. The budget bounds the sum, not each plugin.
  sum.instance(
    "several plugins cannot add up past the budget, and all of them still register",
    () =>
      withPlugins(
        [markerPlugin("a", 250), markerPlugin("b", 250), markerPlugin("c", 250)],
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          const started = Date.now()
          yield* plugin.init()
          const elapsed = Date.now() - started

          // Serial construction costs ~750ms; boot pays the 300ms budget instead.
          expect(elapsed).toBeLessThan(650)
          // The plugins queued behind the budget are deferred, not dropped.
          expect(yield* waitForMarkers((value) => value.length === 3, 10_000)).toEqual(["a", "b", "c"])
        }),
      ),
    20_000,
  )

  generous.instance(
    "on-time plugins keep configured hook order regardless of settle order",
    () =>
      withPlugins(
        [markerPlugin("first", 200), markerPlugin("second", 5), markerPlugin("third", 90)],
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          yield* plugin.init()
          expect(yield* markers()).toEqual(["first", "second", "third"])
        }),
      ),
    20_000,
  )
})
