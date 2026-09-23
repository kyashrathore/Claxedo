import { createEffect, createMemo, createRoot, createSignal, on, type Accessor } from "solid-js"
import { requirementsMet, type PluginApi, type PluginModule, type PluginRequirement } from "@claxedo/plugin-api"
import { activatePlugin, type Activation } from "./activation"
import type { PluginOrigin, PluginState, PluginSummary } from "./api"
import { failureReason } from "./boundary"
import { pluginMachine } from "./model"
import type { PluginPreferences } from "./preferences"
import type { RegistrationSink } from "./registrations"

export type PluginHostDeps = {
  readonly preferences: PluginPreferences
  readonly features: Accessor<Readonly<Record<PluginRequirement, boolean>>>
  readonly buildApi: (module: PluginModule, sink: RegistrationSink) => PluginApi
  readonly removeLive: (id: string) => Promise<void>
}

export type PluginHost = {
  readonly plugins: Accessor<readonly PluginSummary[]>
  readonly plugin: (id: string) => PluginSummary | undefined
  readonly add: (module: PluginModule, origin: PluginOrigin) => void
  readonly replace: (module: PluginModule, origin: PluginOrigin) => void
  readonly drop: (id: string) => void
  readonly remove: (id: string) => Promise<void>
  readonly switchOn: (id: string) => void
  readonly switchOff: (id: string) => void
  readonly safeMode: Accessor<boolean>
  readonly leaveSafeMode: () => void
}

type Entry = {
  readonly id: string
  readonly module: Accessor<PluginModule>
  readonly setModule: (module: PluginModule) => void
  readonly origin: Accessor<PluginOrigin>
  readonly setOrigin: (origin: PluginOrigin) => void
  readonly state: Accessor<PluginState>
  readonly dispose: () => void
}

export function createPluginHost(deps: PluginHostDeps): PluginHost {
  const [entries, setEntries] = createSignal<readonly Entry[]>([])
  const { preferences } = deps

  const wanted = (entry: Entry) => {
    const live = entry.origin().kind === "live"
    if (live && (preferences.safeMode() || !preferences.confirmed(entry.id))) return false
    return preferences.enabled(entry.id) && requirementsMet(entry.module().manifest, deps.features())
  }

  const summaries = createMemo<readonly PluginSummary[]>(() =>
    entries().map((entry) => ({
      manifest: entry.module().manifest,
      origin: entry.origin(),
      enabled: preferences.enabled(entry.id),
      requirementsMet: requirementsMet(entry.module().manifest, deps.features()),
      confirmed: entry.origin().kind === "bundled" || preferences.confirmed(entry.id),
      state: entry.state(),
    })),
  )

  const add = (module: PluginModule, origin: PluginOrigin) => {
    if (entries().some((entry) => entry.id === module.manifest.id)) throw new Error(`Plugin ${module.manifest.id} is already registered`)
    const entry = createEntry(module, origin, (current) => wanted(current), deps.buildApi)
    setEntries((current) => [...current, entry])
  }

  const drop = (id: string) => {
    const entry = entries().find((current) => current.id === id)
    if (!entry) return
    entry.dispose()
    setEntries((current) => current.filter((candidate) => candidate !== entry))
  }

  return {
    plugins: summaries,
    plugin: (id) => summaries().find((summary) => summary.manifest.id === id),
    add,
    replace: (module, origin) => {
      const entry = entries().find((current) => current.id === module.manifest.id)
      if (!entry) return add(module, origin)
      entry.setOrigin(origin)
      entry.setModule(module)
    },
    drop,
    remove: async (id) => {
      const entry = entries().find((current) => current.id === id)
      if (!entry || entry.origin().kind !== "live") return
      await deps.removeLive(id)
      drop(id)
      preferences.forget(id)
    },
    switchOn: (id) => preferences.setEnabled(id, true),
    switchOff: (id) => preferences.setEnabled(id, false),
    safeMode: preferences.safeMode,
    leaveSafeMode: preferences.leaveSafeMode,
  }
}

function createEntry(
  initial: PluginModule,
  initialOrigin: PluginOrigin,
  wanted: (entry: Entry) => boolean,
  buildApi: PluginHostDeps["buildApi"],
): Entry {
  return createRoot((dispose) => {
    const [module, setModule] = createSignal(initial)
    const [origin, setOrigin] = createSignal(initialOrigin)
    const machine = pluginMachine()
    const entry: Entry = {
      id: initial.manifest.id,
      module,
      setModule,
      origin,
      setOrigin,
      state: machine.state,
      dispose: () => {
        running?.dispose()
        running = undefined
        dispose()
      },
    }
    let running: Activation | undefined
    let generation = 0

    const stop = () => {
      generation++
      running?.dispose()
      running = undefined
      machine.send({ type: "switchOff" })
    }

    const start = async (next: PluginModule) => {
      const attempt = ++generation
      const swapping = running !== undefined
      machine.send(swapping ? { type: "swap", to: next.manifest.version } : { type: "switchOn", version: next.manifest.version })
      try {
        const activation = await activatePlugin({
          module: next,
          buildApi: (sink) => buildApi(next, sink),
          onLateFailure: (reason) => {
            if (attempt !== generation) return
            stop()
            machine.send({ type: "switchOn", version: next.manifest.version })
            machine.send({ type: "activationFailed", reason })
          },
        })
        if (attempt !== generation) {
          activation.dispose()
          return
        }
        running?.dispose()
        running = activation
        machine.send({ type: "activated" })
      } catch (error) {
        if (attempt !== generation) return
        machine.send({ type: "activationFailed", reason: failureReason(error) })
      }
    }

    createEffect(
      on(
        () => [wanted(entry), module()] as const,
        ([isWanted, next]) => {
          if (!isWanted) {
            if (running || machine.state().kind !== "off") stop()
            return
          }
          if (running?.version === next.manifest.version) return
          if (failedVersion(machine.state()) === next.manifest.version) return
          void start(next)
        },
      ),
    )

    return entry
  })
}

function failedVersion(state: PluginState): string | undefined {
  return state.kind === "failed" ? state.version : undefined
}
