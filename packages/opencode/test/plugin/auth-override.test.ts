import { describe, expect, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { ProviderAuth } from "@/provider/auth"

import { RuntimeFlags } from "@/effect/runtime-flags"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Config } from "@/config/config"
import { Plugin } from "@/plugin/index"

const it = testEffect(LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, FSUtil.node])))

function providerAuthLayer(directory: string, plugins: string[]) {
  return LayerNode.compile(ProviderAuth.node, [
    [
      Config.node,
      TestConfig.layer({
        get: () =>
          Effect.succeed({
            plugin: plugins,
            plugin_origins: plugins.map((plugin) => ({
              spec: plugin,
              source: path.join(directory, "opencode.json"),
              scope: "local" as const,
            })),
          }),
        directories: () => Effect.succeed([directory]),
      }),
    ],
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ])
}

describe("plugin.auth-override", () => {
  it.instance(
    "user plugin overrides built-in github-copilot auth",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const fs = yield* FSUtil.Service
        const pluginDir = path.join(tmp.directory, ".opencode", "plugin")

        yield* fs.writeWithDirs(
          path.join(pluginDir, "custom-copilot-auth.ts"),
          [
            "export default {",
            '  id: "demo.custom-copilot-auth",',
            "  server: async () => ({",
            "    auth: {",
            '      provider: "github-copilot",',
            "      methods: [",
            '        { type: "api", label: "Test Override Auth" },',
            "      ],",
            "      loader: async () => ({ access: 'test-token' }),",
            "    },",
            "  }),",
            "}",
            "",
          ].join("\n"),
        )

        const plain = yield* tmpdirScoped({ git: true })
        const plugin = pathToFileURL(path.join(pluginDir, "custom-copilot-auth.ts")).href
        const methods = yield* ProviderAuth.use
          .methods()
          .pipe(Effect.provide(providerAuthLayer(tmp.directory, [plugin])))
        const plainMethods = yield* ProviderAuth.use
          .methods()
          .pipe(Effect.provide(providerAuthLayer(plain, [])), provideInstance(plain))

        const copilot = methods[ProviderV2.ID.make("github-copilot")]
        expect(copilot).toBeDefined()
        expect(copilot.length).toBe(1)
        expect(copilot[0].label).toBe("Test Override Auth")
        expect(plainMethods[ProviderV2.ID.make("github-copilot")][0].label).not.toBe("Test Override Auth")
      }),
    { git: true },
    30000,
  )
})

const file = path.join(import.meta.dir, "../../src/plugin/index.ts")

function pluginLayer(directory: string, plugins: string[]) {
  return LayerNode.compile(Plugin.node, [
    [
      Config.node,
      TestConfig.layer({
        get: () =>
          Effect.succeed({
            plugin: plugins,
            plugin_origins: plugins.map((plugin) => ({
              spec: plugin,
              source: path.join(directory, "opencode.json"),
              scope: "local" as const,
            })),
          }),
        directories: () => Effect.succeed([directory]),
      }),
    ],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ])
}

describe("plugin.config-hook-error-isolation", () => {
  test("failure log message is preserved", async () => {
    const src = await Bun.file(file).text()
    expect(src).toContain("plugin config hook failed")
  })

  // Exercises the property the previous source-text pattern approximated: one plugin's throwing
  // `config` hook must not abort boot and must not skip any other plugin's `config` hook.
  it.instance(
    "a throwing config hook does not abort boot or skip other plugins",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const fs = yield* FSUtil.Service
        const marker = path.join(tmp.directory, "config-hook.txt")
        const specs: string[] = []

        for (const [name, body] of [
          ["throws", 'throw new Error("config hook exploded")'],
          ["records", `await Bun.write(${JSON.stringify(marker)}, "records")`],
        ] as const) {
          const target = path.join(tmp.directory, ".opencode", "plugin", `config-${name}.ts`)
          yield* fs.writeWithDirs(
            target,
            [
              "export default {",
              `  id: "demo.config-${name}",`,
              "  server: async () => ({",
              "    config: async () => {",
              `      ${body}`,
              "    },",
              "  }),",
              "}",
              "",
            ].join("\n"),
          )
          specs.push(pathToFileURL(target).href)
        }

        // Boot completes even though the first plugin's config hook throws.
        yield* Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          yield* plugin.init()
        }).pipe(Effect.provide(pluginLayer(tmp.directory, specs)))

        // The plugin registered after the throwing one still received config.
        expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("records")
      }),
    { git: true },
    30000,
  )
})
