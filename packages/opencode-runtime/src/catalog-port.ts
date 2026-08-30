/**
 * Read-only workspace catalogs: agents, commands, models.
 *
 * These are the surfaces that returned empty 500s in the broken upstream
 * beta-18314 build (contract doc §2.3), so the port's contract about failure
 * matters as much as its shape: an unavailable SDK RAISES. It never answers
 * with an empty list.
 * A fabricated empty catalog is indistinguishable in the UI from "this
 * workspace genuinely has no agents", and Unit 1 recorded that as the exact
 * failure mode to keep out (R8).
 *
 * Provider/model identity for the PICKER is not here — Claxedo owns that
 * catalog through `opencodeProviderCatalog` (models.dev backed). `models()`
 * below reports what the running host can actually resolve for a workspace,
 * which is a different question and has a different authority.
 */
import type { OpenCodeHost } from "./host"
import type { WorkspaceScope } from "./scope"

export type AgentEntry = Readonly<{
  name: string
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
  const ref = value as { providerID?: unknown; id?: unknown } | undefined
  if (typeof ref?.providerID !== "string" || typeof ref.id !== "string") return undefined
  return { providerID: ref.providerID, id: ref.id }
}

/** V2 returns `{ location, data }` for location-scoped lists. */
function rows(response: unknown): readonly Record<string, unknown>[] {
  const data = (response as { data?: unknown }).data
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : []
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
