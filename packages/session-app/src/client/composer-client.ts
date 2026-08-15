/**
 * Composer data client — everything the composer needs beyond the session
 * routes in `local-server-client.ts`, against the REAL local Claxedo server:
 *
 *   GET /api/claxedo/agent-config/harness?directory=…       active/default harness
 *   GET /api/claxedo/agent-config/harness/options?…&harness=…  model + effort options
 *   GET /provider?directory=…&harness=…[&provider=…]        provider catalog (models per provider)
 *   GET /permission/modes?directory=…&harness=…             modes for a draft (no session yet)
 *   GET /session/:id/permission-mode?directory=…            modes for an existing session
 *   GET /api/claxedo/workspace                              cloud+local workspaces with access kind
 *   GET /experimental/worktree?directory=…                  worktree directories of the project
 *   POST /experimental/worktree?directory=…  {name?}        create → {name, branch, directory}
 *   GET /provider/auth                                      credential providers + auth methods
 *   PUT /api/claxedo/credentials  {provider_id, kind, secret}  store an API key
 *
 * Route/shape sources: claxedo-local-server agent-config/routes/harness-routes.ts,
 * opencode/compat-routes/{index,provider-config,worktree-routes}.ts,
 * workspace/routes/resolve-route.ts, credentials/routes/{credential,provider-auth}.ts,
 * and workspace-runtime routes/session-core.ts. All decoders are tolerant:
 * junk entries are dropped, unknown fields ignored, error bodies surfaced as
 * empty results with an `error` message rather than throws where the composer
 * can degrade (harness options), and thrown for calls that must not silently
 * no-op (createWorktree, putCredential).
 */

import type {
  EffortOption,
  HarnessSummary,
  ModelOption,
  PermissionModeOption,
  WorkspaceSummary,
  WorktreeSummary,
} from "../core/model"

/**
 * The harness roster the app shows. The main app renders this fixed set
 * (`HARNESS_OPTIONS` in agent-harness-selector.tsx) — the server has no
 * roster route; per-harness data (models, modes) is then fetched per id.
 */
export const HARNESS_ROSTER: ReadonlyArray<{ id: string; name: string }> = [
  { id: "claude-acp", name: "Claude" },
  { id: "codex-acp", name: "Codex" },
  { id: "cursor-acp", name: "Cursor" },
  { id: "claude-sdk", name: "Claude SDK" },
  { id: "codex-app-server", name: "Codex App Server" },
  { id: "cursor-sdk", name: "Cursor SDK" },
  { id: "pi", name: "Pi" },
  { id: "opencode", name: "OpenCode" },
]

export type HarnessOptionsResult = {
  models: ModelOption[]
  efforts: EffortOption[]
  source: "harness" | "catalog" | "empty"
  stale: boolean
  /** Set when the server answered with an error body instead of options. */
  error?: string
}

export type ProviderCatalog = {
  providers: Array<{
    id: string
    name: string
    models: ModelOption[]
  }>
  /** Provider ids with working credentials. */
  connected: string[]
  /** Configured default model per provider id. */
  defaults: Record<string, string>
  error?: string
}

export type PermissionModesResult = {
  modes: PermissionModeOption[]
  currentModeId?: string
  /** Present when this harness has no permission-mode surface at all. */
  unsupported?: string
}

export type CredentialProvider = {
  id: string
  methods: Array<{ type: "oauth" | "api"; label: string }>
}

export type StoredCredential = {
  id: string
  providerId: string
  kind: string
  status?: string
}

export type ComposerClient = {
  listHarnesses(directory?: string): Promise<HarnessSummary[]>
  harnessOptions(input: { directory: string; harness: string; sessionId?: string }): Promise<HarnessOptionsResult>
  providerCatalog(input: { directory?: string; harness?: string; provider?: string }): Promise<ProviderCatalog>
  permissionModes(input: { directory: string; harness?: string; sessionId?: string }): Promise<PermissionModesResult>
  listWorkspaces(): Promise<WorkspaceSummary[]>
  listWorktrees(directory: string): Promise<string[]>
  createWorktree(input: { directory: string; name?: string }): Promise<WorktreeSummary>
  listCredentialProviders(harness?: string): Promise<CredentialProvider[]>
  putCredential(input: { providerId: string; apiKey: string }): Promise<StoredCredential>
}

export function createComposerClient(options: {
  baseUrl: string
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>
}): ComposerClient {
  const fetcher = options.fetcher ?? ((url, init) => globalThis.fetch(url, init))
  const url = (path: string, query: Record<string, string | undefined> = {}) => {
    const u = new URL(path, options.baseUrl)
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) u.searchParams.set(key, value)
    }
    return u.href
  }

  async function json(response: Response): Promise<unknown> {
    if (!response.ok) throw new Error(`${response.status}: ${(await response.text()).slice(0, 300)}`)
    return await response.json()
  }

  return {
    async listHarnesses(directory) {
      // The roster itself is fixed; the agent-config harness route names the
      // ACTIVE harness so the composer can preselect it. A server without the
      // route (or an errored one) still yields the full roster.
      let activeKey: string | undefined
      try {
        const body = await json(await fetcher(url("/api/claxedo/agent-config/harness", { directory })))
        activeKey = decodeActiveHarness(body)
      } catch {
        activeKey = undefined
      }
      return HARNESS_ROSTER.map((h) => (h.id === activeKey ? { ...h, active: true } : { ...h }))
    },

    async harnessOptions(input) {
      const response = await fetcher(url("/api/claxedo/agent-config/harness/options", {
        directory: input.directory,
        harness: input.harness,
        sessionId: input.sessionId,
      }))
      const body = await response.json().catch(() => undefined)
      const error = decodeErrorMessage(body) ?? (response.ok ? undefined : `options request failed: ${response.status}`)
      if (error) {
        return { models: [], efforts: [], source: "empty", stale: true, error }
      }
      return decodeHarnessOptions(body, input.harness)
    },

    async providerCatalog(input) {
      const response = await fetcher(url("/provider", {
        directory: input.directory,
        harness: input.harness,
        provider: input.provider,
      }))
      const body = await response.json().catch(() => undefined)
      const error = decodeErrorMessage(body) ?? (response.ok ? undefined : `provider request failed: ${response.status}`)
      if (error) {
        return { providers: [], connected: [], defaults: {}, error }
      }
      return decodeProviderCatalog(body)
    },

    async permissionModes(input) {
      // A draft has no session: the directory-scoped route answers. An
      // existing session reads its own mode surface (ACP modes are per
      // session).
      const body = input.sessionId
        ? await json(await fetcher(url(
            `/session/${encodeURIComponent(input.sessionId)}/permission-mode`,
            { directory: input.directory, harness: input.harness },
          )))
        : await json(await fetcher(url("/permission/modes", { directory: input.directory, harness: input.harness })))
      return decodePermissionModes(body)
    },

    async listWorkspaces() {
      const body = await json(await fetcher(url("/api/claxedo/workspace")))
      return decodeWorkspaces(body)
    },

    async listWorktrees(directory) {
      const body = await json(await fetcher(url("/experimental/worktree", { directory })))
      if (!Array.isArray(body)) return []
      return body.filter((item): item is string => typeof item === "string")
    },

    async createWorktree(input) {
      const body = await json(await fetcher(url("/experimental/worktree", { directory: input.directory }), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input.name !== undefined ? { name: input.name } : {}),
      }))
      const worktree = decodeWorktree(body)
      if (!worktree) throw new Error(decodeErrorMessage(body) ?? "create worktree: response carried no worktree")
      return worktree
    },

    async listCredentialProviders(harness) {
      const body = await json(await fetcher(url("/provider/auth", { harness })))
      return decodeCredentialProviders(body)
    },

    async putCredential(input) {
      const body = await json(await fetcher(url("/api/claxedo/credentials"), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider_id: input.providerId, kind: "api_key", secret: input.apiKey }),
      }))
      const credential = decodeStoredCredential(body)
      if (!credential) throw new Error(decodeErrorMessage(body) ?? "put credential: response carried no credential")
      return credential
    },
  }
}

// ---------------------------------------------------------------------------
// Decoders — exported for direct tests. All tolerant of junk.
// ---------------------------------------------------------------------------

function rec(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
}

function str(input: unknown): string | undefined {
  return typeof input === "string" ? input : undefined
}

/** `{error: {code, message}}` bodies the local server answers errors with. */
export function decodeErrorMessage(body: unknown): string | undefined {
  const error = rec(rec(body)?.error)
  if (!error) return undefined
  return str(error.message) ?? str(error.code) ?? "request failed"
}

/**
 * The active harness KEY from `GET /api/claxedo/agent-config/harness` —
 * `activeType` is access-qualified (e.g. "claude-acp"), which is what the
 * roster ids use.
 */
export function decodeActiveHarness(body: unknown): string | undefined {
  const record = rec(body)
  if (!record) return undefined
  return str(record.activeType) ?? str(record.id)
}

/**
 * `OptionsResponse` from the agent-config harness options route: options carry
 * a `category` — "model" and "thought_level" are the two the composer renders.
 * ACP sends `options` (`value`/`name`), the native-SDK path `selectOptions`
 * (`id`/`name`); both are accepted, mirroring the main app's extractors.
 */
export function decodeHarnessOptions(body: unknown, harness: string): HarnessOptionsResult {
  const record = rec(body)
  const options = Array.isArray(record?.options) ? record.options : []
  const source = record?.source === "harness" || record?.source === "catalog" ? record.source : "empty"
  const stale = record?.stale === true

  const choices = (categoryOption: Record<string, unknown> | undefined): Array<{ id: string; name: string; description?: string }> => {
    if (!categoryOption) return []
    const select = Array.isArray(categoryOption.selectOptions) ? categoryOption.selectOptions : []
    if (select.length > 0) {
      return select.flatMap((item) => {
        const row = rec(item)
        const id = str(row?.id)
        if (!id) return []
        return [{ id, name: str(row?.name) ?? id, ...(str(row?.description) ? { description: str(row?.description)! } : {}) }]
      })
    }
    const plain = Array.isArray(categoryOption.options) ? categoryOption.options : []
    return plain.flatMap((item) => {
      const row = rec(item)
      const id = str(row?.value)
      if (!id) return []
      return [{ id, name: str(row?.name) ?? id, ...(str(row?.description) ? { description: str(row?.description)! } : {}) }]
    })
  }

  const byCategory = (category: string) =>
    options.map(rec).find((option) => option?.category === category && option.type === "select")

  const models: ModelOption[] = choices(byCategory("model")).map((choice) => ({
    providerID: harness,
    modelID: choice.id,
    name: choice.name,
    ...(choice.description ? { description: choice.description } : {}),
  }))
  const efforts: EffortOption[] = choices(byCategory("thought_level")).map((choice) => ({
    id: choice.id,
    name: choice.name,
  }))

  return { models, efforts, source, stale }
}

/**
 * `GET /provider` catalog: `{all: [{id, name, models: Record<modelID, info>}],
 * connected: string[], default: Record<providerID, modelID>}`. The index view
 * ships empty `models` maps; the per-provider detail view fills them (the
 * detail's model info carries `variants` — the reasoning-effort levels —
 * which surface as the model's description-free effort ids downstream).
 */
export function decodeProviderCatalog(body: unknown): ProviderCatalog {
  const record = rec(body)
  const all = Array.isArray(record?.all) ? record.all : []
  const providers = all.flatMap((item) => {
    const provider = rec(item)
    const id = str(provider?.id)
    if (!id) return []
    const modelsRecord = rec(provider?.models) ?? {}
    const models: ModelOption[] = Object.entries(modelsRecord).flatMap(([modelID, value]) => {
      const info = rec(value)
      if (info?.status === "deprecated") return []
      return [{
        providerID: id,
        modelID,
        name: str(info?.name) ?? modelID,
      }]
    })
    return [{ id, name: str(provider?.name) ?? id, models }]
  })
  const connected = Array.isArray(record?.connected)
    ? record.connected.filter((item): item is string => typeof item === "string")
    : []
  const defaults: Record<string, string> = {}
  for (const [key, value] of Object.entries(rec(record?.default) ?? {})) {
    if (typeof value === "string") defaults[key] = value
  }
  return { providers, connected, defaults }
}

/** Effort variants a `/provider?provider=…` detail row advertises for a model. */
export function decodeModelVariants(body: unknown, providerID: string, modelID: string): EffortOption[] {
  const all = Array.isArray(rec(body)?.all) ? (rec(body)!.all as unknown[]) : []
  const provider = all.map(rec).find((item) => item?.id === providerID)
  const model = rec(rec(provider?.models)?.[modelID])
  const variants = rec(model?.variants)
  if (!variants) return []
  return Object.keys(variants).map((id) => ({ id, name: id }))
}

/** `AgentPermissionModeState` from the permission-mode routes. */
export function decodePermissionModes(body: unknown): PermissionModesResult {
  const record = rec(body)
  const modes = (Array.isArray(record?.modes) ? record.modes : []).flatMap((item): PermissionModeOption[] => {
    const row = rec(item)
    const id = str(row?.id)
    if (!id) return []
    return [{
      id,
      name: str(row?.name) ?? id,
      ...(str(row?.description) ? { description: str(row?.description)! } : {}),
      ...(str(row?.level) ? { level: str(row?.level)! } : {}),
    }]
  })
  return {
    modes,
    ...(str(record?.currentModeId) ? { currentModeId: str(record?.currentModeId)! } : {}),
    ...(str(record?.unsupported) ? { unsupported: str(record?.unsupported)! } : {}),
  }
}

/** `GET /api/claxedo/workspace` → `{workspaces: [workspaceResponse…]}`. */
export function decodeWorkspaces(body: unknown): WorkspaceSummary[] {
  const list = rec(body)?.workspaces
  if (!Array.isArray(list)) return []
  return list.flatMap((item): WorkspaceSummary[] => {
    const row = rec(item)
    const workspaceId = str(row?.workspaceId)
    const directory = str(row?.directory)
    if (!workspaceId || !directory) return []
    const access = row?.access === "cloud" || row?.access === "user-hosted" ? row.access : "local"
    const git = rec(row?.git)
    return [{
      workspaceId,
      directory,
      access,
      ...(str(row?.workspaceName) ? { name: str(row?.workspaceName)! } : {}),
      ...(str(git?.branch) ? { branch: str(git?.branch)! } : {}),
    }]
  })
}

/** `{name, branch, directory}` from `POST /experimental/worktree`. */
export function decodeWorktree(body: unknown): WorktreeSummary | undefined {
  const row = rec(body)
  const name = str(row?.name)
  const branch = str(row?.branch)
  const directory = str(row?.directory)
  if (!name || !branch || !directory) return undefined
  return { name, branch, directory }
}

/** `GET /provider/auth` → `Record<providerId, [{type, label}]>`. */
export function decodeCredentialProviders(body: unknown): CredentialProvider[] {
  const record = rec(body)
  if (!record) return []
  return Object.entries(record).flatMap(([id, value]): CredentialProvider[] => {
    if (!Array.isArray(value)) return []
    const methods = value.flatMap((item): Array<{ type: "oauth" | "api"; label: string }> => {
      const row = rec(item)
      const raw = row?.type
      const type = raw === "oauth" || raw === "api" ? raw : undefined
      const label = str(row?.label)
      if (!type || !label) return []
      return [{ type, label }]
    })
    return [{ id, methods }]
  })
}

/** `{credential: {id, provider_id, kind, status, …}}` from the credential PUT. */
export function decodeStoredCredential(body: unknown): StoredCredential | undefined {
  const credential = rec(rec(body)?.credential)
  const id = str(credential?.id)
  const providerId = str(credential?.provider_id)
  const kind = str(credential?.kind)
  if (!id || !providerId || !kind) return undefined
  return { id, providerId, kind, ...(str(credential?.status) ? { status: str(credential?.status)! } : {}) }
}
