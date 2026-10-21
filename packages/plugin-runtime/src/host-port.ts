import type { PluginCaller, PluginPlatformAnswer, PluginPlatformCall } from "@claxedo/plugin-api/backend"
import type { PluginBackend, PluginManifest } from "@claxedo/plugin-api/manifest"

/** One plugin in one organization: the unit a supervisor runs and every capability is scoped to. */
export type PluginScope = Readonly<{ orgId: string; pluginId: string }>

/** The scope every capability of a loaded backend is bound to: one activation epoch of one plugin in one organization. */
export type PluginRunScope = PluginScope & Readonly<{ epoch: number }>

/** Who a request the host forwards is for: a person the host authenticated, or anyone holding one of the plugin's public links. */
export type PluginRequestCaller = PluginScope & (Readonly<{ origin: "person"; userId: string }> | Readonly<{ origin: "link" }>)

/** Who a tool call is for: an agent acting for a user the host authenticated, from the session and project its credential names. */
export type PluginAgentCaller = PluginScope &
  Readonly<{ origin: "agent"; userId: string; session?: PluginCaller["session"]; ownerDriven?: boolean; projectId?: string }>

export type PluginBackendActivation = Readonly<{
  /** Rises on every change to the plugin's install and is never reused; every capability is fenced by it. */
  epoch: number
  /** SHA-256 of the backend bundle, 64 lowercase hex digits. */
  bundleHash: string
  manifest: PluginManifest & { backend: PluginBackend }
}>

/** The plugin's latest epoch in its organization, with the activation it names while the backend is active. */
export type PluginBackendState = Readonly<{ epoch: number; activation?: PluginBackendActivation }>

/** The platform calls a host answers; the runtime answers `identity.caller` and the schedule itself. */
export type PluginHostCall = Exclude<PluginPlatformCall, { name: "identity.caller" | "schedule.at" | "schedule.cancel" | "schedule.list" }>

/**
 * What a host gives the runtime. The hosted Worker answers from D1, R2 and its
 * live-sync rooms. `readState` and `readBundle` are asked again on every
 * request the supervisor serves, so they must be cheap and must never answer
 * from a cache that can lag an install change.
 */
export type PluginHostPort = Readonly<{
  /**
   * The install's current state. An epoch lower than one the supervisor has
   * already seen is ignored as stale, so the host may answer from a replica
   * that lags, but never with an epoch that was not written.
   */
  readState(orgId: string, pluginId: string): Promise<PluginBackendState>
  /** The bundle stored under `sha256`, or undefined when none is. The runtime verifies the digest itself. */
  readBundle(sha256: string): Promise<string | undefined>
  /**
   * Runs a call the runtime has already admitted: its epoch is current, the
   * manifest declares its permission, its fields parsed, and `caller` is the
   * live caller of its handle, which every call that acts as a person has.
   * The host decides what that person may do.
   */
  platform(call: PluginHostCall, scope: PluginRunScope, caller: PluginCaller | undefined): Promise<PluginPlatformAnswer>
  /** Overrides of the runtime's limits that a host chooses for itself. */
  limits?: Readonly<{ blobTotalBytes?: number }>
}>
