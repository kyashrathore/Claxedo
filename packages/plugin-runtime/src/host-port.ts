import type { PluginBackend, PluginManifest } from "@claxedo/plugin-api/manifest"

/** One plugin in one organization: the unit a supervisor runs and every capability is scoped to. */
export type PluginScope = Readonly<{ orgId: string; pluginId: string }>

/** The scope every capability of a loaded backend is bound to: one activation epoch of one plugin in one organization. */
export type PluginRunScope = PluginScope & Readonly<{ epoch: number }>

/** The person a request to the backend was made for, as the host authenticated them. */
export type PluginCaller = PluginScope & Readonly<{ userId: string }>

/** What a live caller handle resolves to inside the backend's own run. */
export type PluginCallerRecord = Readonly<{ userId: string; orgId: string }>

export type PluginBackendActivation = Readonly<{
  /** Rises on every change to the plugin's install and is never reused; every capability is fenced by it. */
  epoch: number
  /** SHA-256 of the backend bundle, 64 lowercase hex digits. */
  bundleHash: string
  manifest: PluginManifest & { backend: PluginBackend }
}>

/** The plugin's latest epoch in its organization, with the activation it names while the backend is active. */
export type PluginBackendState = Readonly<{ epoch: number; activation?: PluginBackendActivation }>

/**
 * What a host gives the runtime. The hosted Worker answers from D1 and R2,
 * the local daemon from its own store over its loopback service. Both reads
 * are asked again on every request the supervisor serves, so they must be
 * cheap and must never answer from a cache that can lag an install change.
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
}>
