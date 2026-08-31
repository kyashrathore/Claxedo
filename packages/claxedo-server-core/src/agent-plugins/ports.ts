import type { AgentPluginCollectionSource } from "./catalog/types"

/**
 * Product-owned catalog boundary. The product returns only sources the current
 * actor may read; Agent Plugins does not configure repositories or credentials.
 */
export type CatalogSourceProvider = {
  listAuthorizedSources(options?: { fresh?: boolean }): Promise<readonly AgentPluginCollectionSource[]>
}

/** Schedules application of a committed activation revision. */
export type AgentPluginReconcilePort = {
  reconcile(revision: number): Promise<{ state: "applied" | "scheduled" }>
}
