import { createEffect, createRoot, createSignal, on, type Accessor } from "solid-js"
import type { Activation } from "./activation"
import { failureReason } from "./failure"
import { buildIdOf, failedBuildId, pluginMachine, type PluginBuild, type PluginState } from "./model"

export type Activate = (build: PluginBuild, onCrash: (reason: string) => void) => Promise<Activation>

export type PluginLifecycle = {
  readonly id: string
  readonly build: Accessor<PluginBuild>
  readonly setBuild: (build: PluginBuild) => void
  readonly state: Accessor<PluginState>
  readonly dispose: () => void
}

type ActivationRunner = {
  readonly start: (next: PluginBuild) => Promise<void>
  readonly stop: () => void
  readonly settledOn: (buildId: string) => boolean
}

function createActivationRunner(machine: ReturnType<typeof pluginMachine>, activate: Activate): ActivationRunner {
  let running: Activation | undefined
  let starting: string | undefined
  let attempt = 0
  const stop = () => {
    attempt++
    starting = undefined
    running?.dispose()
    running = undefined
  }
  const crash = (current: number, reason: string) => {
    if (current !== attempt) return
    stop()
    machine.send({ type: "crashed", reason })
  }
  const start = async (next: PluginBuild) => {
    const current = ++attempt
    const id = buildIdOf(next)
    starting = id
    machine.send(running ? { type: "swapStarted", to: id } : { type: "switchedOn", build: id })
    try {
      const activation = await activate(next, (reason) => crash(current, reason))
      if (current !== attempt) return activation.dispose()
      starting = undefined
      running?.dispose()
      running = activation
      machine.send({ type: "activated" })
    } catch (error) {
      if (current !== attempt) return
      starting = undefined
      machine.send({ type: "activationFailed", reason: failureReason(error) })
    }
  }
  const settledOn = (id: string) => running?.build === id || starting === id || failedBuildId(machine.state()) === id
  return { start, stop, settledOn }
}

export function createPluginLifecycle(initial: PluginBuild, wanted: (build: PluginBuild) => boolean, activate: Activate): PluginLifecycle {
  return createRoot((disposeRoot) => {
    const [build, setBuild] = createSignal(initial)
    const machine = pluginMachine()
    const runner = createActivationRunner(machine, activate)
    createEffect(
      on([() => wanted(build()), build], ([isWanted, next]) => {
        if (!isWanted) {
          runner.stop()
          machine.send({ type: "switchedOff" })
          return
        }
        if (!runner.settledOn(buildIdOf(next))) void runner.start(next)
      }),
    )
    return {
      id: initial.manifest.id,
      build,
      setBuild,
      state: machine.state,
      dispose: () => {
        runner.stop()
        disposeRoot()
      },
    }
  })
}
