import type { AgentPluginCollectionSource } from "./catalog/types"
import type { SignedControlPlaneAuth } from "../platform/auth/auth"

/**
 * Product-owned catalog boundary. The product returns only sources the current
 * actor may read; Agent Plugins does not configure repositories or credentials.
 */
export type CatalogSourceProvider = {
  listAuthorizedSources(options?: { fresh?: boolean }): Promise<readonly AgentPluginCollectionSource[]>
}

/**
 * Applies a committed activation revision. A signed rail passes the caller,
 * whose running sandboxes are the ones the revision reaches.
 */
export type AgentPluginReconcilePort = {
  reconcile(revision: number, auth?: SignedControlPlaneAuth): Promise<{ state: "applied" | "scheduled" }>
}
