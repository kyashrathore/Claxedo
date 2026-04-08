import { authFetch, getClaxedoServerUrl, getDefaultBaseUrl } from "./api"

export type WorkgraphSlice = {
  slice_id: string
  repo_ref: string | null
  repo_label: string | null
  goal: string
  kind: "spec" | "doc" | "issue"
  title: string
  content: string
  source_path: string | null
  status: string
  plan_run_id: string | null
  last_run_id: string | null
  trace_run_id: string | null
  runtime_type: string | null
  session_id: string | null
  pty_id: string | null
  directory: string | null
  worktree_path: string | null
  provider: WorkgraphProvider | null
  provider_connection_id: string | null
  import_mode: WorkgraphQueryMode | null
  import_query: Record<string, unknown> | null
  mission_item_id: string | null
  error: string | null
  created_at: string
  updated_at: string
}

export type WorkgraphProvider = "github" | "linear"

export type WorkgraphQueryMode =
  | "single_item"
  | "assigned_to_me"
  | "updated_since"
  | "project_or_team"

export type WorkgraphConnection = {
  connection_id: string
  provider: WorkgraphProvider
  name: string
  status: string
  error: string | null
  created_at: string
  updated_at: string
}

export type WorkgraphPreview = {
  id: string
  provider: WorkgraphProvider
  repo_ref?: string | null
  repo_label?: string | null
  provider_meta: Record<string, unknown>
  title: string
  description: string
  status: "open" | "closed" | "in_progress"
  provider_url: string
  external_key?: string
  parent_external_key?: string | null
  child_external_keys?: string[]
  aggregate_only?: boolean
}

export type WorkgraphAuthRequired = {
  kind: "auth_required"
  provider: WorkgraphProvider
  message: string
  hint: string
}

export type WorkgraphPreviewResult =
  | {
      kind: "preview"
      provider: WorkgraphProvider
      mode: WorkgraphQueryMode
      items: WorkgraphPreview[]
    }
  | WorkgraphAuthRequired

export type WorkgraphImportResult =
  | {
      kind: "imported"
      slice: WorkgraphSlice
      mission: WorkgraphItem
      items: WorkgraphItem[]
    }
  | WorkgraphAuthRequired

export type WorkgraphItem = {
  item_id: string
  parent_id: string | null
  repo_ref: string | null
  repo_label: string | null
  node_type: "task" | "mission" | "synthesis"
  title: string
  description: string
  status: "open" | "in_progress" | "done"
  labels: string[]
  context: string | null
  provider: string | null
  provider_meta: Record<string, unknown> | null
  provider_url: string | null
  created_at: string
  updated_at: string
  blocked: boolean
  ready: boolean
  blockers: number
  dependents: number
  slices: Array<{ slice_id: string; title: string; kind: string; status: string }>
  active_run_id: string | null
  latest_run_id: string | null
  runtime_type: string | null
  attempt_id: string | null
  attempt_status: string | null
  session_id: string | null
  pty_id: string | null
  directory: string | null
  worktree_path: string | null
}

export type WorkgraphRun = {
  run_id: string
  goal: string
  status: string
  slice_id: string | null
  created_at: string | null
  updated_at: string | null
  runtime_type: string
  attempt_id: string | null
  attempt_status: string | null
  session_id: string | null
  pty_id: string | null
  directory: string | null
  worktree_path: string | null
  node_id: string
}

export type WorkgraphAttempt = {
  attempt_id: string
  run_id: string
  node_id: string
  status: string
  runtime_type: string
  directory: string | null
  worktree_path: string | null
  session_id: string | null
  pty_id: string | null
  started_at: string
  finished_at: string | null
  last_heartbeat_at: string
}

export type WorkgraphSession = {
  id: string
  directory: string
  title: string
  time: {
    created: number
    updated: number
  }
}

export type WorkgraphEvent = {
  id: string
  run_id: string
  stream_id: string
  stream_seq: number
  logical_ts: number
  schema_version: number
  type: string
  payload_json: string
  actor_type: string
  actor_id: string
  op_id: string
  prev_hash: string
  hash: string
  created_at: string
}

export type WorkgraphScratchpad = {
  id: string
  workItemId: string
  content: string
  priority: "fyi" | "blocking" | "scope_change"
  needsReview: boolean
  promotedToItemId?: string
  dismissedAt?: string
  actor: string
  createdAt: string
}

export type WorkgraphArtifact = {
  artifact_id: string
  node_id: string | null
  type: string
  content: string
  created_at: string
}

export type WorkgraphRelations = {
  blockers: WorkgraphItem[]
  dependents: WorkgraphItem[]
  children: WorkgraphItem[]
  descendants: WorkgraphItem[]
  synthesis: WorkgraphItem | null
  slices: WorkgraphSlice[]
  runs: WorkgraphRun[]
  attempts: WorkgraphAttempt[]
  trace: WorkgraphEvent[]
  scratchpads: WorkgraphScratchpad[]
  descendant_scratchpads: WorkgraphScratchpad[]
}

export type WorkgraphItemArtifacts = {
  artifacts: WorkgraphArtifact[]
  descendant_artifacts: WorkgraphArtifact[]
  synthesis_artifact: WorkgraphArtifact | null
}

export type WorkgraphItemsPage = {
  items: WorkgraphItem[]
  next_cursor: string | null
}

export type WorkgraphDetail = WorkgraphRelations & { item: WorkgraphItem } & WorkgraphItemArtifacts

export type WorkgraphIntakeResult =
  | {
      route: "ingest_text"
      next_action: "stop_after_ingest" | "plan_graph"
      kind?: "spec" | "doc"
      title?: string
      goal?: string
      content: string
    }
  | {
      route: "provider_query"
      next_action: "stop_after_ingest" | "plan_graph"
      provider: WorkgraphProvider
      mode: WorkgraphQueryMode
      query: Record<string, unknown>
      title?: string
      goal?: string
    }
  | {
      route: "missing_info"
      next_action: "stop_after_ingest" | "plan_graph"
      message: string
    }
  | {
      route: "handoff_session"
      next_action: "stop_after_ingest" | "plan_graph"
      message: string
    }

function normalizeRelations(input: WorkgraphRelations): WorkgraphRelations {
  return {
    blockers: input.blockers ?? [],
    dependents: input.dependents ?? [],
    children: input.children ?? [],
    descendants: input.descendants ?? [],
    synthesis: input.synthesis ?? null,
    slices: input.slices ?? [],
    runs: input.runs ?? [],
    attempts: input.attempts ?? [],
    trace: input.trace ?? [],
    scratchpads: input.scratchpads ?? [],
    descendant_scratchpads: input.descendant_scratchpads ?? [],
  }
}

function normalizeArtifacts(input: WorkgraphItemArtifacts): WorkgraphItemArtifacts {
  return {
    artifacts: input.artifacts ?? [],
    descendant_artifacts: input.descendant_artifacts ?? [],
    synthesis_artifact: input.synthesis_artifact ?? null,
  }
}

export function normalizeItem(item: WorkgraphItem): WorkgraphItem {
  return {
    ...item,
    labels: item.labels ?? [],
    slices: item.slices ?? [],
    parent_id: item.parent_id ?? null,
    repo_ref: item.repo_ref ?? null,
    repo_label: item.repo_label ?? null,
    node_type: item.node_type ?? "task",
  }
}

export type WorkgraphSpec = {
  goal?: string
  kind?: "spec" | "doc"
  title?: string
  content: string
  source_path?: string
  repo_ref?: string
  repo_label?: string
  directory?: string
}

export type WorkgraphItemsQuery = {
  status?: string
  slice_id?: string
  run_id?: string
  repo_ref?: string
  attention?: boolean
  search?: string
  cursor?: string
  limit?: number
}

export type WorkgraphRepoBinding = {
  repo_ref: string
  repo_label: string
  project_root: string
  project_id?: string | null
  project_name?: string | null
}

export type WorkgraphRepoBucket = {
  repo_ref: string | null
  repo_label: string
  item_count: number
  slice_count: number
  bindings: WorkgraphRepoBinding[]
  bound: boolean
}

function base() {
  return `${getClaxedoServerUrl()}/api/workgraph`
}

function looksLikeHtml(res: Response) {
  const type = typeof res.headers?.get === "function" ? res.headers.get("content-type") || "" : ""
  return type.includes("text/html")
}

function htmlErr() {
  return "WorkGraph API resolved to app HTML. Set VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:3001."
}

function fallback(url: string) {
  const parsed = new URL(url)
  if (!["localhost", "127.0.0.1"].includes(parsed.hostname)) return
  if (parsed.port === "4096") return
  return `http://127.0.0.1:4096${parsed.pathname}${parsed.search}${parsed.hash}`
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const next = {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  }
  let res = await authFetch(url, next)
  if (res.ok && looksLikeHtml(res)) {
    const alt = fallback(url)
    if (alt) {
      const retry = await authFetch(alt, next)
      if (!retry.ok || !looksLikeHtml(retry)) {
        res = retry
      }
    }
  }
  if (res.ok && looksLikeHtml(res)) throw new Error(htmlErr())
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(txt || `Request failed: ${res.status}`)
  }
  return res.json()
}

function query(input: WorkgraphItemsQuery) {
  const params = new URLSearchParams()
  if (input.status) params.set("status", input.status)
  if (input.slice_id) params.set("slice_id", input.slice_id)
  if (input.run_id) params.set("run_id", input.run_id)
  if (input.repo_ref) params.set("repo_ref", input.repo_ref)
  if (input.attention) params.set("attention", "true")
  if (input.search) params.set("search", input.search)
  if (input.cursor) params.set("cursor", input.cursor)
  if (input.limit) params.set("limit", String(input.limit))
  const text = params.toString()
  return text ? `?${text}` : ""
}

export const workgraphApi = {
  connections(provider?: WorkgraphProvider) {
    const params = new URLSearchParams()
    if (provider) params.set("provider", provider)
    const text = params.toString()
    return request<WorkgraphConnection[]>(`${base()}/graph/providers/connections${text ? `?${text}` : ""}`)
  },

  connect(input: { provider: WorkgraphProvider; name?: string; token: string }) {
    return request<WorkgraphConnection>(`${base()}/graph/providers/connections`, {
      method: "POST",
      body: JSON.stringify(input),
    })
  },

  validateConnection(id: string) {
    return request<WorkgraphConnection & { label: string | null }>(`${base()}/graph/providers/connections/${id}/validate`, {
      method: "POST",
      body: JSON.stringify({}),
    })
  },

  deleteConnection(id: string) {
    return request<{ deleted: boolean }>(`${base()}/graph/providers/connections/${id}`, {
      method: "DELETE",
    })
  },

  queryProvider(input: {
    provider?: WorkgraphProvider
    connection_id?: string
    mode: WorkgraphQueryMode
    repo_ref?: string
    repo_label?: string
    limit?: number
    query?: Record<string, unknown>
  }) {
    return request<WorkgraphPreviewResult>(`${base()}/graph/providers/query`, {
      method: "POST",
      body: JSON.stringify(input),
    })
  },

  importProvider(input: {
    provider?: WorkgraphProvider
    connection_id?: string
    mode: WorkgraphQueryMode
    repo_ref?: string
    repo_label?: string
    directory?: string
    title?: string
    goal?: string
    query?: Record<string, unknown>
    items?: Array<{
      provider_meta: Record<string, unknown>
      title: string
      provider_url?: string
      external_key?: string
    }>
  }) {
    return request<WorkgraphImportResult>(`${base()}/graph/providers/import`, {
      method: "POST",
      body: JSON.stringify(input),
    })
  },

  items(input: WorkgraphItemsQuery = {}) {
    return request<WorkgraphItemsPage>(`${base()}/graph/items${query(input)}`)
  },

  item(id: string) {
    return request<WorkgraphRelations>(`${base()}/graph/items/${id}`).then(normalizeRelations)
  },

  itemArtifacts(id: string) {
    return request<WorkgraphItemArtifacts>(`${base()}/graph/items/${id}/artifacts`).then(normalizeArtifacts)
  },

  deleteItem(id: string) {
    return request<{ deleted: boolean }>(`${base()}/graph/items/${id}`, { method: "DELETE" })
  },

  slices(repo_ref?: string) {
    const params = new URLSearchParams()
    if (repo_ref) params.set("repo_ref", repo_ref)
    const text = params.toString()
    return request<WorkgraphSlice[]>(`${base()}/graph/slices${text ? `?${text}` : ""}`)
  },

  repos() {
    return request<WorkgraphRepoBucket[]>(`${base()}/graph/repos`)
  },

  sliceEvents(sliceId: string) {
    return request<WorkgraphEvent[]>(`${base()}/graph/slices/${sliceId}/events`)
  },

  sessions(dir: string) {
    const params = new URLSearchParams()
    params.set("directory", dir)
    params.set("roots", "true")
    params.set("limit", "20")
    return request<WorkgraphSession[]>(`${getDefaultBaseUrl()}/session?${params.toString()}`)
  },

  ingest(input: WorkgraphSpec) {
    return request<WorkgraphSlice>(`${base()}/graph/slices`, {
      method: "POST",
      body: JSON.stringify(input),
    })
  },

  plan(sliceId: string, directory?: string) {
    return request<WorkgraphSlice>(`${base()}/graph/slices/${sliceId}/plan`, {
      method: "POST",
      body: JSON.stringify(directory ? { directory } : {}),
    })
  },

  run(input: {
    root_item_id?: string
    item_ids?: string[]
    slice_id?: string
    run_id?: string
    directory?: string
    status?: string
    search?: string
    goal?: string
  }) {
    return request<{
      created: boolean
      run_id?: string
      ready_ids: string[]
      blocked: Array<{
        item_id: string
        title: string
        blocked_item_ids: string[]
      }>
      skipped: Array<{
        item_id: string
        title: string
        blocked_by: string[]
        active: boolean
        status: string
      }>
    }>(`${base()}/graph/runs`, {
      method: "POST",
      body: JSON.stringify(input),
    })
  },
}
