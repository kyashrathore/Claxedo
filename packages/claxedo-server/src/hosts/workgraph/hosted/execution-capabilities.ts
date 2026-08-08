import type { SandboxManager } from "@claxedo/sandbox-manager"
import {
  EXECUTION_CAPABILITY_CATALOG_MAX_AGE_MS,
  type ExecutionConnectionCapability,
  type WorkGraphContext,
} from "@claxedo/workgraph/contracts"
import { ExecutionCapabilitiesUnavailableError } from "@claxedo/workgraph/ports"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { RelayProvider } from "../../../adapters/relay"
import type { ClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"
import { createExecutionCapabilitiesPort } from "../execution-capabilities"

type HostedExecutionCapabilitiesInput = Readonly<{
  authority: WorkspaceAuthority
  sandboxManager: SandboxManager
  relayProvider: RelayProvider
  defaultHomeRegion: ClaxedoRegion
  auth(context: WorkGraphContext): SignedControlPlaneAuth | undefined
  readConnections(context: WorkGraphContext): Promise<readonly ExecutionConnectionCapability[]>
  connectionToolIds: readonly string[]
  now?: () => number
  requestTimeoutMs?: number
  catalogStartupTimeoutMs?: number
  modelCatalogTimeoutMs?: number
  modelCatalogRetryDelayMs?: number
  request?: (url: string, init?: RequestInit) => Promise<Response>
}>

const DEFAULT_CATALOG_REQUEST_TIMEOUT_MS = 30_000
// A cold Cloudflare catalog sandbox measures ~32s from `ensure` to ready against
// staging, and ~24s warm. At 30s the budget expired a second or two before the
// container came up, so the refresh reported `runtime_unavailable` for a sandbox
// that was about to work — and the caller's own two-minute retry loop then spent
// itself on 30s retries that could never win. 55s leaves room for the cold path
// while still expiring inside the smoke's 60s per-retry abort, so a genuinely
// stuck sandbox surfaces as a structured retryable error rather than a transport
// timeout that says nothing about which side gave up.
const DEFAULT_CATALOG_STARTUP_TIMEOUT_MS = 55_000
const DEFAULT_MODEL_CATALOG_RETRY_DELAY_MS = 500

export function createHostedExecutionCapabilities(input: HostedExecutionCapabilitiesInput) {
  const now = input.now ?? Date.now
  const reads = new Map<string, Readonly<{ expiresAt: number; value: Promise<HostedCatalog> }>>()
  const refreshes = new Map<string, Promise<HostedCatalog>>()
  const catalog = (context: WorkGraphContext) => {
    const key = tenantKey(context)
    const refreshing = refreshes.get(key)
    if (refreshing) return refreshing
    const existing = reads.get(key)
    if (existing && now() < existing.expiresAt) return existing.value
    const entry = {
      expiresAt: now() + EXECUTION_CAPABILITY_CATALOG_MAX_AGE_MS,
      value: readHostedCatalog(input, context),
    }
    reads.set(key, entry)
    void entry.value.catch(() => {
      if (reads.get(key) === entry) reads.delete(key)
    })
    return entry.value
  }
  const refreshCatalog = (context: WorkGraphContext) => {
    const key = tenantKey(context)
    const existing = refreshes.get(key)
    if (existing) return existing
    const previous = reads.get(key)?.value
    const operation = (async () => {
      if (previous) await Promise.allSettled([previous])
      const value = await readTransientHostedCatalog(input, context)
      reads.set(key, {
        expiresAt: now() + EXECUTION_CAPABILITY_CATALOG_MAX_AGE_MS,
        value: Promise.resolve(value),
      })
      return value
    })()
    refreshes.set(key, operation)
    void operation.then(
      () => {
        if (refreshes.get(key) === operation) refreshes.delete(key)
      },
      () => {
        if (refreshes.get(key) === operation) refreshes.delete(key)
      },
    )
    return operation
  }

  const capabilities = createExecutionCapabilitiesPort({
    environment: {
      kind: "hosted_workspace",
      repositoryRequired: false,
      remoteUrlInput: true,
      baseRevisionInput: true,
    },
    readRuntime: async (context) => (await catalog(context)).runtime,
    readRepository: async () => ({ baseRevisions: [] }),
    readConnections: input.readConnections,
    connectionToolIds: input.connectionToolIds,
    ...(input.now ? { now: input.now } : {}),
  })
  return {
    ...capabilities,
    async refresh(context: WorkGraphContext) {
      await refreshCatalog(context)
      return capabilities.read(context, {})
    },
  }
}

type HostedCatalog = Readonly<{
  runtime: Readonly<{ harness: unknown; agents: unknown; providers: unknown; tools: unknown }>
}>

async function readHostedCatalog(
  input: HostedExecutionCapabilitiesInput,
  context: WorkGraphContext,
): Promise<HostedCatalog> {
  const auth = input.auth(context)
  if (!auth) {
    throw new ExecutionCapabilitiesUnavailableError(
      "catalog_workspace",
      "catalog_workspace_unavailable",
      "The signed owner context for hosted capability discovery is unavailable",
      false,
    )
  }
  const orgId = await input.authority.resolveOrgId(auth).catch(() => {
    throw new ExecutionCapabilitiesUnavailableError(
      "catalog_workspace",
      "catalog_workspace_unavailable",
      "The WorkGraph owner's durable organization identity is unavailable",
      false,
    )
  })
  const workspaceId = await catalogWorkspaceId(context.organizationId, context.ownerUserId)
  const placement = await input.sandboxManager.target(workspaceId)
  if (placement.status !== "ready") {
    throw new ExecutionCapabilitiesUnavailableError(
      "catalog_workspace",
      "runtime_unavailable",
      "The hosted capability catalog runtime is not ready yet",
      true,
    )
  }
  const token = await input.relayProvider.mintRuntimeAccessToken({
    workspaceId,
    hostId: placement.hostId,
    subject: auth.user.subject,
    orgId,
    role: "owner",
    ttlMs: 10 * 60_000,
  })
  const relay = await input.relayProvider.getRelayEndpoint(workspaceId, placement.homeRegion as ClaxedoRegion)
  const request = async (pathname: string) => {
    const url = `${relay.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(workspaceId)}${pathname}`
    const response = await (input.request ?? fetch)(url, {
      headers: {
        authorization: `Bearer ${token.token}`,
        "x-opencode-directory": "/workspace",
        "accept-encoding": "identity",
      },
      signal: AbortSignal.timeout(input.requestTimeoutMs ?? DEFAULT_CATALOG_REQUEST_TIMEOUT_MS),
    }).catch((error) => {
      const target = new URL(url)
      throw new Error(
        `Hosted execution catalog ${target.pathname}${target.search} via ${target.host} failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    if (!response.ok) {
      const body = await response.clone().json().catch(() => undefined)
      const error = body && typeof body === "object" && "error" in body && body.error && typeof body.error === "object"
        ? body.error as Record<string, unknown>
        : undefined
      const code = typeof error?.code === "string" ? ` (${error.code})` : ""
      const target = new URL(url)
      const trace = response.headers.get("x-claxedo-trace-id")
      const timing = response.headers.get("server-timing")
      const diagnostics = [
        trace ? `trace=${trace}` : undefined,
        timing ? `timing=${timing}` : undefined,
        response.headers.get("x-claxedo-relay-location-hint") ? "relay-location=present" : undefined,
        response.headers.get("content-type") ? `content-type=${response.headers.get("content-type")}` : undefined,
        response.headers.get("content-length") ? `content-length=${response.headers.get("content-length")}` : undefined,
      ]
        .filter((value): value is string => !!value)
        .join(", ")
      throw new Error(
        `Hosted execution catalog ${target.pathname}${target.search} via ${target.host} failed with ${response.status}${code}${diagnostics ? ` [${diagnostics}]` : ""}`,
      )
    }
    return response.json()
  }
  const [harness, agents, providers, tools] = await Promise.all([
    request("/session/capabilities?directory=%2Fworkspace"),
    request("/agent?directory=%2Fworkspace"),
    readHostedModelCatalog(input, request),
    request("/experimental/tool/ids"),
  ]).catch((error) => {
    if (error instanceof ExecutionCapabilitiesUnavailableError) throw error
    throw new ExecutionCapabilitiesUnavailableError(
      "runtime",
      "runtime_unavailable",
      error instanceof Error ? error.message : "Hosted Workspace Runtime catalog discovery failed",
      true,
    )
  })
  return {
    runtime: { harness, agents, providers, tools },
  }
}

async function readHostedModelCatalog(
  input: HostedExecutionCapabilitiesInput,
  request: (pathname: string) => Promise<unknown>,
) {
  const timeoutMs = input.modelCatalogTimeoutMs ?? DEFAULT_CATALOG_REQUEST_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  while (true) {
    const catalog = await request("/api/model")
    if (hasExecutableModel(catalog)) return catalog
    if (Date.now() >= deadline) {
      throw new Error(`Hosted execution model catalog remained empty for ${timeoutMs}ms`)
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(input.modelCatalogRetryDelayMs ?? DEFAULT_MODEL_CATALOG_RETRY_DELAY_MS, deadline - Date.now())),
    )
  }
}

function hasExecutableModel(input: unknown) {
  const root = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
  if (Array.isArray(root?.data)) {
    return root.data.some((value) => {
      const model = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
      return typeof model?.providerID === "string"
        && !!model.providerID.trim()
        && typeof model.id === "string"
        && !!model.id.trim()
        && model.enabled !== false
        && model.status !== "deprecated"
    })
  }
  if (!Array.isArray(root?.all) || !Array.isArray(root.connected)) return false
  const connected = new Set(root.connected.filter((value): value is string => typeof value === "string" && !!value.trim()))
  return root.all.some((value) => {
    const provider = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
    if (typeof provider?.id !== "string" || !connected.has(provider.id)) return false
    const models = provider.models && typeof provider.models === "object" && !Array.isArray(provider.models)
      ? provider.models as Record<string, unknown>
      : undefined
    return models && Object.values(models).some((value) => {
      const model = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
      return typeof model?.id === "string" && !!model.id.trim() && model.status !== "deprecated"
    })
  })
}

async function provisionCatalogWorkspace(input: HostedExecutionCapabilitiesInput, context: WorkGraphContext) {
  if (!input.auth(context)) {
    throw new ExecutionCapabilitiesUnavailableError(
      "catalog_workspace",
      "catalog_workspace_unavailable",
      "The signed owner context for hosted capability discovery is unavailable",
      false,
    )
  }
  const workspaceId = await catalogWorkspaceId(context.organizationId, context.ownerUserId)
  const deadline = Date.now() + (input.catalogStartupTimeoutMs ?? DEFAULT_CATALOG_STARTUP_TIMEOUT_MS)
  while (true) {
    const placement = await input.sandboxManager.ensure(workspaceId, {
      homeRegion: input.defaultHomeRegion,
      runtimeCwd: "/workspace",
      labels: {
        workload: "workgraph-catalog",
        organizationId: context.organizationId,
        ownerUserId: context.ownerUserId,
      },
      source: { kind: "empty" },
      exposure: { kind: "relay" },
    })
    if (placement.status === "ready") return workspaceId
    if (placement.status !== "provisioning") {
      throw new ExecutionCapabilitiesUnavailableError(
        "catalog_workspace",
        "runtime_unavailable",
        placement.error ?? "The hosted capability catalog runtime is unavailable",
        true,
      )
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new ExecutionCapabilitiesUnavailableError(
        "catalog_workspace",
        "runtime_unavailable",
        `The hosted capability catalog remained provisioning for ${input.catalogStartupTimeoutMs ?? DEFAULT_CATALOG_STARTUP_TIMEOUT_MS}ms`,
        true,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(1, placement.retryAfterMs), remaining)))
  }
}

async function readTransientHostedCatalog(input: HostedExecutionCapabilitiesInput, context: WorkGraphContext) {
  const workspaceId = await provisionCatalogWorkspace(input, context)
  let value: HostedCatalog
  try {
    value = await readHostedCatalog(input, context)
  } catch (error) {
    await destroyCatalogWorkspace(input, workspaceId)
    throw error
  }
  await destroyCatalogWorkspace(input, workspaceId)
  return value
}

async function destroyCatalogWorkspace(input: HostedExecutionCapabilitiesInput, workspaceId: string) {
  let destroyed: Awaited<ReturnType<SandboxManager["destroy"]>>
  try {
    destroyed = await input.sandboxManager.destroy(workspaceId)
  } catch (error) {
    throw catalogWorkspaceCleanupError(error)
  }
  if (!destroyed.ok) {
    if (destroyed.reason === "runtime_lease_missing") return
    throw catalogWorkspaceCleanupError(`Hosted capability catalog destroy failed: ${destroyed.reason}`)
  }
  try {
    await input.sandboxManager.release(workspaceId)
  } catch (error) {
    throw catalogWorkspaceCleanupError(error)
  }
}

function catalogWorkspaceCleanupError(error: unknown) {
  return new ExecutionCapabilitiesUnavailableError(
    "catalog_workspace",
    "catalog_workspace_unavailable",
    error instanceof Error ? error.message : String(error),
    true,
  )
}

async function catalogWorkspaceId(organizationId: string, ownerUserId: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(["workgraph-catalog", organizationId, ownerUserId])),
  )
  return `wg-catalog-${Array.from(new Uint8Array(digest).slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

function tenantKey(context: WorkGraphContext) {
  return JSON.stringify([context.organizationId, context.ownerUserId])
}
