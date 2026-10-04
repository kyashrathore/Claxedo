import type { PluginCapability, PluginDefinition, PluginManifest } from "@claxedo/plugin-api"
import type { Translations } from "@/i18n"
import { machine, unreachable, type Machine } from "@/lib/machine"
import type { ApprovalCheck } from "./approval"

export type PluginOrigin = { readonly hash: string; readonly directory: string; readonly builtAt?: string; readonly buildError?: string }

export type PluginBuild = {
  readonly manifest: PluginManifest
  readonly origin: PluginOrigin
  readonly definition: PluginDefinition
  readonly dictionary?: Translations
}

export type PluginFailure = { readonly build: string; readonly reason: string }

export type PluginState =
  | { readonly kind: "off" }
  | { readonly kind: "loading"; readonly build: string }
  | { readonly kind: "on"; readonly build: string; readonly lastFailure?: PluginFailure }
  | { readonly kind: "swapping"; readonly build: string; readonly to: string }
  | { readonly kind: "failed"; readonly failure: PluginFailure }

export type PluginEvent =
  | { readonly type: "switchedOn"; readonly build: string }
  | { readonly type: "activated" }
  | { readonly type: "activationFailed"; readonly reason: string }
  | { readonly type: "swapStarted"; readonly to: string }
  | { readonly type: "crashed"; readonly reason: string }
  | { readonly type: "switchedOff" }

export type PluginSummary = {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly manifest: PluginManifest
  readonly origin: PluginOrigin
  readonly switchedOn: boolean
  readonly missing: readonly PluginCapability[]
  readonly approval: ApprovalCheck
  readonly state: PluginState
}

export function buildIdOf(build: PluginBuild): string {
  return build.origin.hash
}

export function pluginTransition(state: PluginState, event: PluginEvent): PluginState {
  switch (event.type) {
    case "switchedOn":
      return state.kind === "on" || state.kind === "swapping" ? state : { kind: "loading", build: event.build }
    case "activated":
      return activated(state)
    case "activationFailed":
      return activationFailed(state, event.reason)
    case "swapStarted":
      return state.kind === "on" || state.kind === "swapping" ? { kind: "swapping", build: state.build, to: event.to } : state
    case "crashed":
      return crashed(state, event.reason)
    case "switchedOff":
      return { kind: "off" }
    default:
      return unreachable(event)
  }
}

function activated(state: PluginState): PluginState {
  switch (state.kind) {
    case "loading":
      return { kind: "on", build: state.build }
    case "swapping":
      return { kind: "on", build: state.to }
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
      return { kind: "failed", failure: { build: state.build, reason } }
    case "swapping":
      return { kind: "on", build: state.build, lastFailure: { build: state.to, reason } }
    case "off":
    case "on":
    case "failed":
      return state
    default:
      return unreachable(state)
  }
}

function crashed(state: PluginState, reason: string): PluginState {
  switch (state.kind) {
    case "on":
    case "swapping":
      return { kind: "failed", failure: { build: state.build, reason } }
    case "off":
    case "loading":
    case "failed":
      return state
    default:
      return unreachable(state)
  }
}

export function pluginMachine(): Machine<PluginState, PluginEvent> {
  return machine<PluginState, PluginEvent>({ kind: "off" }, pluginTransition)
}

export function failedBuildId(state: PluginState): string | undefined {
  return state.kind === "failed" ? state.failure.build : undefined
}

export function failureOf(state: PluginState): PluginFailure | undefined {
  if (state.kind === "failed") return state.failure
  return state.kind === "on" ? state.lastFailure : undefined
}
