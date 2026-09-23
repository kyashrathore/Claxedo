import { machine, unreachable, type Machine } from "@/lib/machine"
import type { PluginState } from "./api"

export type PluginEvent =
  | { readonly type: "switchOn"; readonly version: string }
  | { readonly type: "activated" }
  | { readonly type: "activationFailed"; readonly reason: string }
  | { readonly type: "swap"; readonly to: string }
  | { readonly type: "switchOff" }

export function transition(state: PluginState, event: PluginEvent): PluginState {
  switch (event.type) {
    case "switchOn":
      return state.kind === "off" || state.kind === "failed" ? { kind: "loading", version: event.version } : state
    case "activated":
      return activated(state)
    case "activationFailed":
      return activationFailed(state, event.reason)
    case "swap":
      return state.kind === "on" ? { kind: "swapping", version: state.version, to: event.to } : state
    case "switchOff":
      return { kind: "off" }
    default:
      return unreachable(event)
  }
}

function activated(state: PluginState): PluginState {
  switch (state.kind) {
    case "loading":
      return { kind: "on", version: state.version }
    case "swapping":
      return { kind: "on", version: state.to }
    case "off":
    case "on":
    case "failed":
      return state
    default:
      return unreachable(state)
  }
}

function activationFailed(state: PluginState, reason: string): PluginState {
  switch (state.kind) {
    case "loading":
      return { kind: "failed", reason, version: state.version }
    case "swapping":
      return { kind: "on", version: state.version, lastFailure: { version: state.to, reason } }
    case "off":
    case "on":
    case "failed":
      return state
    default:
      return unreachable(state)
  }
}

export function pluginMachine(): Machine<PluginState, PluginEvent> {
  return machine<PluginState, PluginEvent>({ kind: "off" }, transition)
}

export function runningVersion(state: PluginState): string | undefined {
  switch (state.kind) {
    case "on":
    case "swapping":
      return state.version
    case "off":
    case "loading":
    case "failed":
      return undefined
    default:
      return unreachable(state)
  }
}
