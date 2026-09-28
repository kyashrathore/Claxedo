import type { ProviderCatalogEntry, ProviderModel } from "../../contract"
import { engineRead } from "./engine-read.js"
import { openCodeLocationClient, type OpenCodeHost } from "./host.js"
import type { WorkspaceScope } from "./scope.js"
import { asArrayOrUndefined as arr, asRecord as rec, asString as str } from "@claxedo/helpers/guards"

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

export type ModelEntry = ProviderModel

export type OpenCodeCatalogPort = Readonly<{
  agents(scope: WorkspaceScope): Promise<readonly AgentEntry[]>
  commands(scope: WorkspaceScope): Promise<readonly CommandEntry[]>
  models(scope: WorkspaceScope): Promise<readonly ModelEntry[]>
  providers(scope: WorkspaceScope): Promise<readonly ProviderCatalogEntry[]>
}>

function modelRef(value: unknown): Readonly<{ providerID: string; id: string }> | undefined {
  const ref = rec(value)
  const providerID = str(ref?.providerID)
  const id = str(ref?.id)
  return providerID !== undefined && id !== undefined ? { providerID, id } : undefined
}

function rows(response: unknown): readonly Record<string, unknown>[] {
  const data = arr(rec(response)?.data)
  const items = data?.map(rec)
  if (!items?.every((row): row is Record<string, unknown> => row !== undefined)) {
    throw new Error("OpenCode returned an invalid catalog list")
  }
  return items
}

async function agents(host: OpenCodeHost, scope: WorkspaceScope): Promise<readonly AgentEntry[]> {
      const client = await openCodeLocationClient(host, scope.directory)
      const response = await engineRead("agent.list", scope, () => client.agent.list({ location: { directory: scope.directory } }))
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
}

async function commands(host: OpenCodeHost, scope: WorkspaceScope): Promise<readonly CommandEntry[]> {
      const client = await openCodeLocationClient(host, scope.directory)
      const response = await engineRead("command.list", scope, () => client.command.list({ location: { directory: scope.directory } }))
      return rows(response).map((row) => {
        const model = modelRef(row.model)
        return {
          name: String(row.name),
          ...(typeof row.description === "string" ? { description: row.description } : {}),
          ...(typeof row.agent === "string" ? { agent: row.agent } : {}),
          ...(model === undefined ? {} : { model }),
        }
      })
}

async function models(host: OpenCodeHost, scope: WorkspaceScope): Promise<readonly ModelEntry[]> {
      const client = await openCodeLocationClient(host, scope.directory)
      const response = await engineRead("model.list", scope, () => client.model.list({ location: { directory: scope.directory } }))
      return rows(response).flatMap((row) => {
        const ref = modelRef(row)
        if (ref === undefined) return []
        const variants = (arr(row.variants) ?? []).flatMap((variant) => str(rec(variant)?.id) ?? [])
        const cost = (arr(row.cost) ?? []).flatMap((tier) => {
          const input = rec(tier)?.input
          const output = rec(tier)?.output
          return typeof input === "number" && typeof output === "number" ? [{ input, output }] : []
        })
        return [{
          ...ref,
          ...(typeof row.name === "string" ? { name: row.name } : {}),
          ...(variants.length ? { variants } : {}),
          cost,
        }]
      })
}

function envNames(integration: Record<string, unknown>): string[] {
  return (arr(integration.methods) ?? []).flatMap((method) => {
    const row = rec(method)
    return row?.type === "env" ? (arr(row.names) ?? []).flatMap((name) => str(name) ?? []) : []
  })
}

async function providers(host: OpenCodeHost, scope: WorkspaceScope): Promise<readonly ProviderCatalogEntry[]> {
  const client = await openCodeLocationClient(host, scope.directory)
  const location = { location: { directory: scope.directory } }
  const [integrations, active, listed] = await Promise.all([
    engineRead("integration.list", scope, () => client.integration.list(location)),
    engineRead("provider.list", scope, () => client.provider.list(location)),
    models(host, scope),
  ])
  const entries = new Map<string, { id: string; name: string; env: string[]; active: boolean }>()
  for (const row of rows(integrations)) entries.set(String(row.id), { id: String(row.id), name: String(row.name), env: envNames(row), active: false })
  for (const row of rows(active)) {
    if (row.activation === "disabled") continue
    const id = String(row.id)
    entries.set(id, { id, name: String(row.name), env: entries.get(id)?.env ?? [], active: true })
  }
  for (const model of listed) if (!entries.has(model.providerID)) entries.set(model.providerID, { id: model.providerID, name: model.providerID, env: [], active: false })
  return [...entries.values()].map(({ active: isActive, ...entry }) => {
    const owned = listed.filter((model) => model.providerID === entry.id)
    return { ...entry, connected: isActive && owned.length > 0, models: owned }
  })
}

export function createCatalogPort(host: OpenCodeHost): OpenCodeCatalogPort {
  return {
    agents: (scope) => agents(host, scope),
    commands: (scope) => commands(host, scope),
    models: (scope) => models(host, scope),
    providers: (scope) => providers(host, scope),
  }
}
