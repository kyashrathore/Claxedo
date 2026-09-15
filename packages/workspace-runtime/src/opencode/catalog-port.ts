/**
 * Read-only workspace catalogs: agents, commands, models.
 *
 * An unavailable SDK raises; the port never answers with an empty list, because
 * a fabricated empty catalog is indistinguishable in the UI from a workspace
 * that genuinely has no agents.
 *
 * Provider/model identity for the picker is not here — Claxedo owns that
 * catalog through `opencodeProviderCatalog` (models.dev backed). `models()`
 * reports what the running host can resolve for a workspace, a different
 * question with a different authority.
 */
import type { OpenCodeHost } from "./host"
import type { WorkspaceScope } from "./scope"
import { arr, rec, str } from "../json-value"

export type AgentEntry = Readonly<{
  name: string
  id?: string
  description?: string
  mode?: string
  model?: Readonly<{ providerID: string; id: string }>
}>

export type CommandEntry = Readonly<{
  name: string
  description?: string
  agent?: string
  model?: Readonly<{ providerID: string; id: string }>
}>

export type ModelEntry = Readonly<{
  providerID: string
  id: string
  name?: string
}>

export type OpenCodeCatalogPort = Readonly<{
  agents(scope: WorkspaceScope): Promise<readonly AgentEntry[]>
  commands(scope: WorkspaceScope): Promise<readonly CommandEntry[]>
  models(scope: WorkspaceScope): Promise<readonly ModelEntry[]>
}>

function modelRef(value: unknown): Readonly<{ providerID: string; id: string }> | undefined {
  const ref = rec(value)
  const providerID = str(ref?.providerID)
  const id = str(ref?.id)
  return providerID !== undefined && id !== undefined ? { providerID, id } : undefined
}

/** V2 returns `{ location, data }` for location-scoped lists. */
function rows(response: unknown): readonly Record<string, unknown>[] {
  const data = arr(rec(response)?.data)
  const items = data?.map(rec)
  if (!items?.every((row): row is Record<string, unknown> => row !== undefined)) {
    throw new Error("OpenCode returned an invalid catalog list")
  }
  return items
}

export function createCatalogPort(host: OpenCodeHost): OpenCodeCatalogPort {
  return {
    async agents(scope) {
      const client = await host.client()
      const response = await client.agent.list({ location: { directory: scope.directory } })
      return rows(response).map((row) => {
        const model = modelRef(row.model)
        return {
          name: String(row.name),
          ...(typeof row.id === "string" ? { id: row.id } : {}),
          ...(typeof row.description === "string" ? { description: row.description } : {}),
          ...(typeof row.mode === "string" ? { mode: row.mode } : {}),
          ...(model === undefined ? {} : { model }),
        }
      })
    },

    async commands(scope) {
      const client = await host.client()
      const response = await client.command.list({ location: { directory: scope.directory } })
      return rows(response).map((row) => {
        const model = modelRef(row.model)
        return {
          name: String(row.name),
          ...(typeof row.description === "string" ? { description: row.description } : {}),
          ...(typeof row.agent === "string" ? { agent: row.agent } : {}),
          ...(model === undefined ? {} : { model }),
        }
      })
    },

    async models(scope) {
      const client = await host.client()
      const response = await client.model.list({ location: { directory: scope.directory } })
      return rows(response).flatMap((row) => {
        const ref = modelRef(row)
        if (ref === undefined) return []
        return [{ ...ref, ...(typeof row.name === "string" ? { name: row.name } : {}) }]
      })
    },
  }
}
