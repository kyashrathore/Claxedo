import { createEffect, createRoot, createSignal, on, type Accessor } from "solid-js"
import type { Activation } from "./activation"
import { failureReason } from "./boundary"
import { buildIdOf, failedBuild, pluginMachine, type PluginBuild, type PluginState } from "./model"

export type Activate = (build: PluginBuild, onCrash: (reason: string) => void) => Promise<Activation>

export type PluginLifecycle = {
  readonly id: string
  readonly build: Accessor<PluginBuild>
  readonly setBuild: (build: PluginBuild) => void
  readonly state: Accessor<PluginState>
  readonly dispose: () => void
}

export function createPluginLifecycle(initial: PluginBuild, wanted: (build: PluginBuild) => boolean, activate: Activate): PluginLifecycle {
  return createRoot((disposeRoot) => {
    const [build, setBuild] = createSignal(initial)
    const machine = pluginMachine()
    let running: Activation | undefined
    let attempt = 0

    const stop = () => {
      attempt++
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
      machine.send(running ? { type: "swapStarted", to: id } : { type: "switchedOn", build: id })
      try {
        const activation = await activate(next, (reason) => crash(current, reason))
        if (current !== attempt) return activation.dispose()
        running?.dispose()
        running = activation
        machine.send({ type: "activated" })
      } catch (error) {
        if (current === attempt) machine.send({ type: "activationFailed", reason: failureReason(error) })
      }
    }

    createEffect(
      on([() => wanted(build()), build], ([isWanted, next]) => {
        if (!isWanted) {
          stop()
          machine.send({ type: "switchedOff" })
          return
        }
        const id = buildIdOf(next)
        if (running?.build === id || failedBuild(machine.state()) === id) return
        void start(next)
      }),
    )

    return {
      id: initial.manifest.id,
      build,
      setBuild,
      state: machine.state,
      dispose: () => {
        stop()
        disposeRoot()
      },
    }
  })
}
