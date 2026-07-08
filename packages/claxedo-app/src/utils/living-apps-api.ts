import { authFetch, getClaxedoServerUrl, normalizeUrl } from "./api"

export type LivingAppStatus = "active" | "paused" | "archived"
export type LivingAppSyncProvider = "local-sqlite" | "turso"

export type LivingAppSyncConfig = {
  provider: LivingAppSyncProvider
  local_path?: string
  remote_url?: string
  auth_secret_ref?: string
  sync_interval_seconds?: number
  offline?: boolean
} & Record<string, unknown>

export type LivingApp = {
  id: string
  workspace_id: string | null
  name: string
  description: string
  status: LivingAppStatus
  shell_spec: unknown
  backend_contract: unknown
  action_bindings: unknown
  data_schema: unknown
  sync_config: LivingAppSyncConfig
  prompt: string
  source_session_id: string | null
  process_ref: string | null
  created_at: number
  updated_at: number
}

export type LivingAppDataSource = {
  id: string
  app_id: string
  kind: string
  label: string
  config: unknown
  created_at: number
  updated_at: number
}

export type LivingAppEvent = {
  id: string
  app_id: string
  type: string
  payload: unknown
  created_at: number
}

export type LivingAppCreateInput = {
  workspace_id?: string
  name: string
  description?: string
  status?: LivingAppStatus
  shell_spec?: unknown
  backend_contract?: unknown
  action_bindings?: unknown
  data_schema?: unknown
  sync_config?: LivingAppSyncConfig
  prompt?: string
  source_session_id?: string | null
  process_ref?: string | null
}

export type LivingAppDataSourceInput = {
  kind: string
  label: string
  config?: unknown
}

const LivingAppsRoute = "/api/claxedo/living-apps"

function url(path = "", input?: { workspace_id?: string }) {
  const suffix = !path ? "" : path.startsWith("/") ? path : `/${path}`
  const serverUrl = getClaxedoServerUrl()
  const target = new URL(`${LivingAppsRoute}${suffix}`, normalizeUrl(serverUrl) ?? serverUrl)
  if (input?.workspace_id) target.searchParams.set("workspace_id", input.workspace_id)
  return String(target)
}

function jsonHeaders(input?: HeadersInit) {
  const headers = new Headers(input)
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json")
  return headers
}

async function request<T>(target: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(target, {
    ...init,
    headers: jsonHeaders(init?.headers),
  })
  if (!res.ok) throw new Error(await res.text() || `Request failed: ${res.status}`)
  return res.json()
}

export const livingAppsApi = {
  list(input?: { workspace_id?: string }): Promise<{ apps: LivingApp[] }> {
    return request(url("", input))
  },

  get(id: string): Promise<{ app: LivingApp }> {
    return request(url(id))
  },

  create(input: LivingAppCreateInput): Promise<{ app: LivingApp }> {
    return request(url(), {
      method: "POST",
      body: JSON.stringify(input),
    })
  },

  update(id: string, patch: Partial<LivingAppCreateInput>): Promise<{ app: LivingApp }> {
    return request(url(id), {
      method: "PATCH",
      body: JSON.stringify(patch),
    })
  },

  delete(id: string): Promise<{ deleted: boolean }> {
    return request(url(id), { method: "DELETE" })
  },

  listDataSources(id: string): Promise<{ data_sources: LivingAppDataSource[] }> {
    return request(url(`${id}/data-sources`))
  },

  createDataSource(id: string, input: LivingAppDataSourceInput): Promise<{ data_source: LivingAppDataSource }> {
    return request(url(`${id}/data-sources`), {
      method: "POST",
      body: JSON.stringify(input),
    })
  },

  updateDataSource(id: string, sourceId: string, patch: Partial<LivingAppDataSourceInput>): Promise<{ data_source: LivingAppDataSource }> {
    return request(url(`${id}/data-sources/${sourceId}`), {
      method: "PATCH",
      body: JSON.stringify(patch),
    })
  },

  deleteDataSource(id: string, sourceId: string): Promise<{ deleted: boolean }> {
    return request(url(`${id}/data-sources/${sourceId}`), { method: "DELETE" })
  },

  listEvents(id: string): Promise<{ events: LivingAppEvent[] }> {
    return request(url(`${id}/events`))
  },

  appendEvent(id: string, input: { type: string; payload?: unknown }): Promise<{ event: LivingAppEvent }> {
    return request(url(`${id}/events`), {
      method: "POST",
      body: JSON.stringify(input),
    })
  },
}
