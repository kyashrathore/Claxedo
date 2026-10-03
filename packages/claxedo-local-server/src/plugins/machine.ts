import type { PluginManifest } from "@claxedo/plugin-api"

export type LivePluginBundle = {
  hash: string
  manifest: PluginManifest
  builtAt: string
}

export type LivePluginState =
  | { kind: "building"; last?: LivePluginBundle }
  | { kind: "ready"; bundle: LivePluginBundle }
  | { kind: "failed"; error: string; last?: LivePluginBundle }

export type LivePluginEvent =
  | { type: "buildStarted" }
  | { type: "buildSucceeded"; bundle: LivePluginBundle }
  | { type: "buildFailed"; error: string }

export function servedBundle(state: LivePluginState): LivePluginBundle | undefined {
  return state.kind === "ready" ? state.bundle : state.last
}

export function initialLivePluginState(last: LivePluginBundle | undefined): LivePluginState {
  return last ? { kind: "ready", bundle: last } : { kind: "building" }
}

export function transitionLivePlugin(state: LivePluginState, event: LivePluginEvent): LivePluginState {
  const last = servedBundle(state)
  switch (event.type) {
    case "buildStarted":
      return { kind: "building", ...(last ? { last } : {}) }
    case "buildSucceeded":
      return { kind: "ready", bundle: event.bundle }
  }
  return { kind: "failed", error: event.error, ...(last ? { last } : {}) }
}
