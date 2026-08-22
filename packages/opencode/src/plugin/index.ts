import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type {
  Hooks,
  PluginInput,
  Plugin as PluginInstance,
  PluginModule,
  WorkspaceAdapter as PluginWorkspaceAdapter,
} from "@opencode-ai/plugin"
import { Config } from "@/config/config"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { ServerAuth } from "@/server/auth"
import { CodexAuthPlugin } from "./openai/codex"
import { Session } from "@/session/session"
import { NamedError } from "@opencode-ai/core/util/error"
import { CopilotAuthPlugin } from "./github-copilot/copilot"
import { gitlabAuthPlugin as GitlabAuthPlugin } from "opencode-gitlab-auth"
import { PoeAuthPlugin } from "opencode-poe-auth"
import { CloudflareAIGatewayAuthPlugin, CloudflareWorkersAuthPlugin } from "./cloudflare"
import { AzureAuthPlugin } from "./azure"
import { DigitalOceanAuthPlugin } from "./digitalocean"
import { XaiAuthPlugin } from "./xai"
import { SnowflakeCortexAuthPlugin } from "./snowflake-cortex"
import { Effect, Layer, Context } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { errorMessage } from "@/util/error"
import { PluginLoader } from "./loader"
import { parsePluginSpecifier, readPluginId, readV1Plugin, resolvePluginId } from "./shared"
import { registerAdapter } from "@/control-plane/adapters"
import type { WorkspaceAdapter } from "@/control-plane/types"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstallationChannel } from "@opencode-ai/core/installation/version"

type State = {
  hooks: Hooks[]
}

// Hook names that follow the (input, output) => Promise<void> trigger pattern
type TriggerName = {
  [K in keyof Hooks]-?: NonNullable<Hooks[K]> extends (input: any, output: any) => Promise<void> ? K : never
}[keyof Hooks]

export interface Interface {
  readonly trigger: <
    Name extends TriggerName,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(
    name: Name,
    input: Input,
    output: Output,
  ) => Effect.Effect<Output>
  readonly list: () => Effect.Effect<Hooks[]>
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Plugin") {}

export function experimentalWebSocketsEnabled(input: { enabled: boolean; channel?: string }) {
  return input.enabled || ["local", "dev", "beta"].includes(input.channel ?? InstallationChannel)
}

// Built-in plugins that are directly imported (not installed from npm)
function internalPlugins(flags: RuntimeFlags.Info): PluginInstance[] {
  return [
    // Temporary rollout: pre-release builds use WebSockets by default; releases require explicit opt-in.
    (input) =>
      CodexAuthPlugin(input, {
        experimentalWebSockets: experimentalWebSocketsEnabled({ enabled: flags.experimentalWebSockets }),
      }),
    CopilotAuthPlugin,
    GitlabAuthPlugin,
    PoeAuthPlugin,
    CloudflareWorkersAuthPlugin,
    CloudflareAIGatewayAuthPlugin,
    AzureAuthPlugin,
    DigitalOceanAuthPlugin,
    SnowflakeCortexAuthPlugin,
    XaiAuthPlugin,
  ]
}

function isServerPlugin(value: unknown): value is PluginInstance {
  return typeof value === "function"
}

function getServerPlugin(value: unknown) {
  if (isServerPlugin(value)) return value
  if (!value || typeof value !== "object" || !("server" in value)) return
  if (!isServerPlugin(value.server)) return
  return value.server
}

function getLegacyPlugins(mod: Record<string, unknown>) {
  const seen = new Set<unknown>()
  const result: PluginInstance[] = []

  for (const entry of Object.values(mod)) {
    if (seen.has(entry)) continue
    seen.add(entry)
    const plugin = getServerPlugin(entry)
    if (!plugin) throw new TypeError("Plugin export is not a function")
    result.push(plugin)
  }

  return result
}

// Returns the hooks a plugin registers instead of mutating shared state, so the caller decides
// whether a result is registered now or, when it misses the init budget, later.
async function applyPlugin(load: PluginLoader.Loaded, input: PluginInput): Promise<Hooks[]> {
  const plugin = readV1Plugin(load.mod, load.spec, "server", "detect")
  if (plugin) {
    await resolvePluginId(load.source, load.spec, load.target, readPluginId(plugin.id, load.spec), load.pkg)
    return [await (plugin as PluginModule).server(input, load.options)]
  }

  const hooks: Hooks[] = []
  for (const server of getLegacyPlugins(load.mod)) {
    hooks.push(await server(input, load.options))
  }
  return hooks
}

/**
 * Wall-clock budget for the whole external plugin construction phase.
 *
 * External plugin constructors are arbitrary third-party code and run before the first request
 * is served (`InstanceBootstrap.run` -> `plugin.init()`), sequentially. `opencode-antigravity-auth@1.6.0`
 * awaits an uncached `fetch` with a 5s timeout whose fallback is a second `fetch` to another host,
 * so one installed plugin can hold instance boot behind >5s of network, and N plugins add up.
 *
 * The budget caps what boot pays. Plugins that miss it are deferred, never dropped: their hooks
 * register against the live hook list as soon as the constructor settles (see `registerLate`).
 * Override with `OPENCODE_PLUGIN_INIT_TIMEOUT_MS`.
 */
const PLUGIN_INIT_BUDGET_MS = 1_000

const PENDING = Symbol("plugin.init.pending")
type Pending = typeof PENDING

/**
 * Awaits every promise, but gives up waiting after `ms` and reports the unfinished ones as
 * `PENDING`. The promises keep running; the caller decides what to do with the stragglers.
 */
async function settleWithin<T>(promises: readonly Promise<T>[], ms: number): Promise<(T | Pending)[]> {
  if (promises.length === 0) return []
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<Pending>((resolve) => {
    timer = setTimeout(() => resolve(PENDING), ms)
    // Do not hold the process open purely to observe our own deadline.
    ;(timer as { unref?: () => void }).unref?.()
  })
  try {
    return await Promise.all(promises.map((promise) => Promise.race([promise, deadline])))
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type PluginOutcome = { readonly ok: true; readonly hooks: Hooks[] } | { readonly ok: false; readonly error: string }

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Plugin.state")(function* (ctx) {
        const hooks: Hooks[] = []
        const bridge = yield* EffectBridge.make()

        function publishPluginError(message: string) {
          bridge.fork(events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() }))
        }

        const { Server } = yield* Effect.promise(() => import("../server/server"))

        const serverUrl = Server.url
        const client = createOpencodeClient({
          baseUrl: serverUrl?.toString() ?? "http://localhost:4096",
          directory: ctx.directory,
          headers: ServerAuth.headers(),
          ...(serverUrl ? {} : { fetch: async (...args) => Server.Default().app.fetch(...args) }),
        })
        const cfg = yield* config.get()
        const input: PluginInput = {
          client,
          project: ctx.project,
          worktree: ctx.worktree,
          directory: ctx.directory,
          experimental_workspace: {
            register(type: string, adapter: PluginWorkspaceAdapter) {
              registerAdapter(ctx.project.id, type, adapter as WorkspaceAdapter)
            },
          },
          get serverUrl(): URL {
            return Server.url ?? new URL("http://localhost:4096")
          },
          // @ts-expect-error
          $: typeof Bun === "undefined" ? undefined : Bun.$,
        }

        for (const plugin of flags.disableDefaultPlugins ? [] : internalPlugins(flags)) {
          const init = yield* Effect.tryPromise({
            try: () => plugin(input),
            catch: errorMessage,
          }).pipe(
            Effect.tapError((error) => Effect.logError("failed to load internal plugin", { name: plugin.name, error })),
            Effect.option,
          )
          if (init._tag === "Some") hooks.push(init.value)
        }

        const plugins = flags.pure ? [] : (cfg.plugin_origins ?? [])
        if (flags.pure && cfg.plugin_origins?.length) {
        }
        if (plugins.length) yield* config.waitForDependencies()

        const loaded = yield* Effect.promise(() =>
          PluginLoader.loadExternal({
            items: plugins,
            kind: "server",
            report: {
              start(candidate) {},
              missing(candidate, _retry, message) {},
              error(candidate, _retry, stage, error, resolved) {
                const spec = candidate.plan.spec
                const cause = error instanceof Error ? (error.cause ?? error) : error
                const message = stage === "load" ? errorMessage(error) : errorMessage(cause)

                if (stage === "install") {
                  const parsed = parsePluginSpecifier(spec)
                  publishPluginError(`Failed to install plugin ${parsed.pkg}@${parsed.version}: ${message}`)
                  return
                }

                if (stage === "compatibility") {
                  publishPluginError(`Plugin ${spec} skipped: ${message}`)
                  return
                }

                if (stage === "entry") {
                  publishPluginError(`Failed to load plugin ${spec}: ${message}`)
                  return
                }

                publishPluginError(`Failed to load plugin ${spec}: ${message}`)
              },
            },
          }),
        )
        // Notify a plugin of current config. Runs for on-time and late plugins alike.
        const notifyConfig = (hook: Hooks) =>
          Effect.tryPromise({
            try: () => Promise.resolve((hook as any).config?.(cfg)),
            catch: errorMessage,
          }).pipe(
            Effect.tapError((error) => Effect.logError("plugin config hook failed", { error })),
            Effect.ignore,
          )

        const disposeHook = (hook: Hooks) =>
          Effect.tryPromise({
            try: () => Promise.resolve(hook.dispose?.()),
            catch: errorMessage,
          }).pipe(
            Effect.tapError((error) => Effect.logError("plugin dispose hook failed", { error })),
            Effect.ignore,
          )

        // Set when the instance is disposed. Hooks that arrive after that are disposed
        // immediately instead of being registered against a dead instance.
        let closed = false

        // Plugin construction stays sequential: `plugin.loader.shared > initializes server plugins
        // in config order` pins that a constructor's side effects never interleave with the next
        // one's. Chaining rather than looping gives every plugin its own promise, so the phase can
        // be observed against a shared deadline without changing execution order.
        let chain: Promise<unknown> = Promise.resolve()
        const entries = loaded
          .filter((load): load is PluginLoader.Loaded => Boolean(load))
          .map((load) => {
            const promise: Promise<PluginOutcome> = chain.then(() =>
              applyPlugin(load, input).then(
                (hooks): PluginOutcome => ({ ok: true, hooks }),
                (err): PluginOutcome => ({ ok: false, error: errorMessage(err) }),
              ),
            )
            chain = promise
            return { load, promise }
          })

        const registerLate = (spec: string, next: Hooks[]) =>
          Effect.gen(function* () {
            if (closed) {
              // Instance already disposed: run the plugin's own teardown and drop it.
              yield* Effect.forEach(next, disposeHook, { discard: true })
              return
            }
            // `hooks` is the same array the materialized state exposes, so `trigger`/`list`
            // observe late arrivals without any re-materialization.
            for (const hook of next) hooks.push(hook)
            for (const hook of next) yield* notifyConfig(hook)
            yield* Effect.logWarning("plugin registered after init budget", { path: spec })
          })

        const budget = flags.pluginInitTimeoutMs ?? PLUGIN_INIT_BUDGET_MS
        const settled = yield* Effect.promise(() =>
          settleWithin(
            entries.map((entry) => entry.promise),
            budget,
          ),
        )

        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i]!
          const outcome = settled[i]!
          if (outcome === PENDING) {
            // Boot proceeds without this plugin, and without the ones queued behind it. None of
            // them are dropped: each registers against the live array when its turn settles.
            yield* Effect.logWarning("plugin exceeded init budget, continuing boot", {
              path: entry.load.spec,
              budget,
            })
            bridge.fork(
              Effect.promise(() => entry.promise).pipe(
                Effect.flatMap((result) =>
                  result.ok
                    ? registerLate(entry.load.spec, result.hooks)
                    : Effect.logError("failed to load plugin", { path: entry.load.spec, error: result.error }),
                ),
              ),
            )
            continue
          }
          if (!outcome.ok) {
            // TODO: make proper events for this
            yield* Effect.logError("failed to load plugin", { path: entry.load.spec, error: outcome.error })
            continue
          }
          // On-time plugins register in load order, preserving hook execution order.
          for (const hook of outcome.hooks) hooks.push(hook)
        }

        // Notify plugins of current config
        for (const hook of hooks) yield* notifyConfig(hook)

        const unsubscribe = yield* events.listen((event) => {
          if (event.location?.directory !== ctx.directory) return Effect.void
          return Effect.sync(() => {
            for (const hook of hooks) {
              void hook["event"]?.({ event: { id: event.id, type: event.type, properties: event.data } as any })
            }
          })
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        yield* Effect.addFinalizer(() =>
          Effect.suspend(() => {
            closed = true
            return Effect.forEach(hooks, disposeHook, { discard: true })
          }),
        )

        return { hooks }
      }),
    )

    const trigger = Effect.fn("Plugin.trigger")(function* <
      Name extends TriggerName,
      Input = Parameters<Required<Hooks>[Name]>[0],
      Output = Parameters<Required<Hooks>[Name]>[1],
    >(name: Name, input: Input, output: Output) {
      if (!name) return output
      const s = yield* InstanceState.get(state)
      for (const hook of s.hooks) {
        const fn = hook[name] as any
        if (!fn) continue
        yield* Effect.promise(async () => fn(input, output))
      }
      return output
    })

    const list = Effect.fn("Plugin.list")(function* () {
      const s = yield* InstanceState.get(state)
      return s.hooks
    })

    const init = Effect.fn("Plugin.init")(function* () {
      yield* InstanceState.get(state)
    })

    return Service.of({ trigger, list, init })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [EventV2Bridge.node, Config.node, RuntimeFlags.node],
})

export * as Plugin from "."
