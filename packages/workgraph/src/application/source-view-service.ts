import type {
  ConnectionID,
  SourceProvider as ContractSourceProvider,
  SourceSyncPolicy as ContractSourceSyncPolicy,
  SourceViewDto,
  WorkGraphContext,
} from "../contracts"
import type { ConnectionsPort } from "../ports"

export type SourceProvider = ContractSourceProvider
export type SourceSyncPolicy = ContractSourceSyncPolicy

export const SOURCE_VIEW_FILTER_KEYS = {
  github: ["repo", "state", "labels"],
  linear: ["team"],
  jira: ["jql"],
} as const satisfies Record<SourceProvider, readonly string[]>

export type SourceView = Readonly<SourceViewDto>

export type SourceViewMutableInput = Readonly<{
  providerUserId: string
  filters: Readonly<Record<string, string>>
  syncPolicy: SourceSyncPolicy
  status: "active" | "paused"
}>

export type SourceViewMutationResult =
  | Readonly<{ ok: true; view: SourceView }>
  | Readonly<{ ok: false; reason: "not_found" | "version_conflict" | "in_use" }>

export type SourceViewStore = Readonly<{
  create(context: WorkGraphContext, view: SourceView): Promise<SourceView>
  read(context: WorkGraphContext, id: string): Promise<SourceView | undefined>
  list(context: WorkGraphContext): Promise<readonly SourceView[]>
  update(
    context: WorkGraphContext,
    id: string,
    input: SourceViewMutableInput & Readonly<{ expectedVersion: number; updatedAt: number }>,
  ): Promise<SourceViewMutationResult>
  delete(
    context: WorkGraphContext,
    id: string,
    input: Readonly<{ expectedVersion: number }>,
  ): Promise<SourceViewMutationResult>
}>

export type SourceViewService = ReturnType<typeof createSourceViewService>

export function createSourceViewService(input: Readonly<{
  store: SourceViewStore
  connections: ConnectionsPort
  ids: Readonly<{ next: () => string }>
  clock?: Readonly<{ now: () => number }>
}>) {
  const clock = input.clock ?? { now: Date.now }

  return {
    async create(context: WorkGraphContext, request: Readonly<{
      teamConnectionId: ConnectionID
      provider: SourceProvider
      providerUserId: string
      filters: Readonly<Record<string, string>>
      syncPolicy?: SourceSyncPolicy
    }>) {
      requireOwner(context)
      await requireConnection(input.connections, context, request)
      const now = clock.now()
      return input.store.create(context, {
        id: input.ids.next(),
        ownerUserId: context.ownerUserId,
        version: 1,
        teamConnectionId: request.teamConnectionId,
        provider: request.provider,
        providerUserId: required(request.providerUserId, "providerUserId"),
        filters: sanitizeSourceViewFilters(request.provider, request.filters),
        syncPolicy: request.syncPolicy ?? "announce",
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
    },
    async update(context: WorkGraphContext, id: string, request: SourceViewMutableInput & Readonly<{ expectedVersion: number }>) {
      requireOwner(context)
      const current = await input.store.read(context, required(id, "sourceViewId"))
      if (!current) throw new SourceViewNotFoundError()
      const target = {
        providerUserId: required(request.providerUserId, "providerUserId"),
        filters: sanitizeSourceViewFilters(current.provider, request.filters),
        syncPolicy: syncPolicy(request.syncPolicy),
        status: sourceViewStatus(request.status),
      }
      const expectedVersion = version(request.expectedVersion)
      if (current.version === expectedVersion + 1 && sameMutableSourceView(current, target)) return current
      if (current.version !== expectedVersion) throw new SourceViewVersionConflictError()
      if (target.status === "active") await requireConnection(input.connections, context, current)
      return sourceViewMutation(await input.store.update(context, current.id, {
        ...target,
        expectedVersion,
        updatedAt: clock.now(),
      }))
    },
    async delete(context: WorkGraphContext, id: string, expectedVersion: number) {
      requireOwner(context)
      return sourceViewMutation(await input.store.delete(context, required(id, "sourceViewId"), {
        expectedVersion: version(expectedVersion),
      }))
    },
    read: (context: WorkGraphContext, id: string) => input.store.read(context, id),
    list: (context: WorkGraphContext) => input.store.list(context),
  }
}

export function providerMatchesIntegration(provider: SourceProvider, integrationId: string) {
  return integrationId === provider || (provider === "jira" && integrationId === "atlassian")
}

export class SourceViewConnectionError extends Error {
  readonly code = "source_view_connection_unavailable" as const
}
export class SourceViewFilterError extends Error {
  readonly code = "source_view_filters_invalid" as const
}
export class SourceViewNotFoundError extends Error {
  readonly code = "source_view_not_found" as const
  constructor() {
    super("Source View not found")
  }
}
export class SourceViewVersionConflictError extends Error {
  readonly code = "source_view_version_conflict" as const
  constructor() {
    super("Source View version changed")
  }
}
export class SourceViewInUseError extends Error {
  readonly code = "source_view_in_use" as const
  constructor() {
    super("Source View has candidates that must be dismissed before deletion")
  }
}

export function sanitizeSourceViewFilters(provider: SourceProvider, filters: unknown): Readonly<Record<string, string>> {
  rejectSecretMaterial(filters)
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) throw new SourceViewFilterError("Source View filters must be a key-value object")
  const supported = SOURCE_VIEW_FILTER_KEYS[provider] as readonly string[]
  return Object.fromEntries(Object.entries(filters).flatMap(([rawKey, rawValue]) => {
    const key = rawKey.trim()
    if (!key) return []
    if (!supported.includes(key)) throw new SourceViewFilterError(`Unsupported ${provider} Source View filter "${key}". Supported filters: ${supported.join(", ")}`)
    if (typeof rawValue !== "string") throw new SourceViewFilterError(`Source View filter "${key}" must be a string`)
    const value = rawValue.trim()
    return value ? [[key, value]] : []
  }))
}

function requireOwner(context: WorkGraphContext) {
  if (context.access.mode !== "owner") throw new Error("Owner access is required")
}

async function requireConnection(connections: ConnectionsPort, context: WorkGraphContext, view: Pick<SourceView, "teamConnectionId" | "provider">) {
  const [handle] = await connections.resolveCapabilities(context, {
    connectionIds: [view.teamConnectionId],
    capability: "work-source",
  })
  if (!handle || handle.id !== view.teamConnectionId || handle.scope !== "team" || !providerMatchesIntegration(view.provider, handle.integrationId)) {
    throw new SourceViewConnectionError("The selected team connection cannot provide this source view")
  }
}

function sourceViewMutation(result: SourceViewMutationResult) {
  if (result.ok) return result.view
  if (result.reason === "not_found") throw new SourceViewNotFoundError()
  if (result.reason === "version_conflict") throw new SourceViewVersionConflictError()
  throw new SourceViewInUseError()
}

function sameMutableSourceView(view: SourceView, input: SourceViewMutableInput) {
  return view.providerUserId === input.providerUserId
    && view.syncPolicy === input.syncPolicy
    && view.status === input.status
    && Object.keys(view.filters).length === Object.keys(input.filters).length
    && Object.entries(view.filters).every(([key, value]) => input.filters[key] === value)
}

function syncPolicy(value: SourceSyncPolicy) {
  if (value === "silent" || value === "announce" || value === "full") return value
  throw new SourceViewFilterError("Source View sync policy is invalid")
}

function sourceViewStatus(value: SourceView["status"]) {
  if (value === "active" || value === "paused") return value
  throw new SourceViewFilterError("Source View status is invalid")
}

function version(value: number) {
  if (!Number.isInteger(value) || value < 1) throw new SourceViewVersionConflictError()
  return value
}

function required(value: string, name: string) {
  const result = value.trim()
  if (!result) throw new Error(`${name} is required`)
  return result
}

function rejectSecretMaterial(value: unknown): void {
  if (typeof value === "string") {
    if (secretValue(value)) throw new SourceViewFilterError("Source View filters cannot contain credential material")
    return
  }
  if (!value || typeof value !== "object") return
  Object.entries(value).forEach(([key, nested]) => {
    if (secretKey(key)) throw new SourceViewFilterError("Source View filters cannot contain credential material")
    rejectSecretMaterial(nested)
  })
}

function secretKey(key: string) {
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "")
  return /^(?:access|api|auth|bearer|client|private|refresh|session)?(?:credential|key|password|secret|token)s?$/.test(normalized)
    || /^(?:authorization|cookie|passphrase)$/.test(normalized)
}

function secretValue(value: string) {
  const normalized = value.trim()
  return /^(?:basic|bearer)\s+\S+/i.test(normalized)
    || /^(?:github_pat_|gh[pousr]_|lin_api_|xox[baprs]-|sk-(?:proj-)?)[A-Za-z0-9_-]{8,}$/i.test(normalized)
    || /^AKIA[A-Z0-9]{16}$/.test(normalized)
    || /^-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(normalized)
    || /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(normalized)
    || /(?:token|api[_-]?key|password|secret|authorization)\s*[:=]\s*\S+/i.test(normalized)
}
