import type { ConnectorInterface, NormalizedIssue, ProviderParams } from "./interface"
import type { WorkGraph } from "../model/workgraph"
import type { ProvenanceInput } from "../model/provenance"

/**
 * The `claxedo` provider — the local substrate exposed behind the SAME
 * connector interface external trackers implement (plan 2026-07-06-004).
 * One code path: native items are just items whose provider is `claxedo`,
 * so nothing downstream ever branches on where an item came from.
 */
export function nativeConnector(wg: () => WorkGraph, actor: () => ProvenanceInput["actor"]): ConnectorInterface {
  const toIssue = (id: string): NormalizedIssue => {
    const item = wg().get(id)
    if (!item) throw new Error(`Native item '${id}' not found`)
    return {
      id: item.id,
      title: item.title,
      description: item.description,
      status: item.status === "done" ? "closed" : item.status === "in_progress" ? "in_progress" : "open",
      provider_url: `claxedo://item/${item.id}`,
      external_key: item.id,
    }
  }

  return {
    provider: "claxedo",

    async hydrateIssue(params: ProviderParams): Promise<NormalizedIssue> {
      return toIssue(String(params.id))
    },

    async updateIssue(params: ProviderParams, updates): Promise<void> {
      const changes: Record<string, unknown> = {}
      if (updates.title) changes.title = updates.title
      if (updates.description) changes.description = updates.description
      if (updates.status === "closed") changes.status = "done"
      if (updates.status === "open") changes.status = "open"
      wg().update(String(params.id), changes, { provenance: { actor: actor() } })
    },

    async addComment(params: ProviderParams, comment: string): Promise<void> {
      wg().writeScratchpad({
        subjectType: "run_node",
        subjectId: String(params.id),
        workItemId: String(params.id),
        kind: "executor",
        content: comment,
        priority: "fyi",
      })
    },

    async createIssue(_params: ProviderParams, data: { title: string; description: string }): Promise<NormalizedIssue> {
      const item = wg().create({
        title: data.title,
        description: data.description,
        provider: "claxedo",
        provenance: { actor: actor() },
      })
      return toIssue(item.id)
    },
  }
}
