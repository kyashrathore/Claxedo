import type { SandboxManager } from "@claxedo/sandbox-manager"
import type { ExecutionConnectionCapability, WorkGraphContext } from "@claxedo/workgraph/contracts"
import { ExecutionCapabilitiesUnavailableError } from "@claxedo/workgraph/ports"
import type { SignedControlPlaneAuth } from "../control-plane/auth"
import type { WorkspaceAuthority } from "../control-plane/authority"
import type { RelayProvider } from "../relay-provider"
import type { ClaxedoRegion } from "../region"
import { createExecutionCapabilitiesPort } from "./execution-capabilities"

type HostedExecutionCapabilitiesInput = Readonly<{
  authority: WorkspaceAuthority
  sandboxManager: SandboxManager
  relayProvider: RelayProvider
  defaultHomeRegion: ClaxedoRegion
  auth(context: WorkGraphContext): SignedControlPlaneAuth | undefined
  readConnections(context: WorkGraphContext): Promise<readonly ExecutionConnectionCapability[]>
  connectionToolIds: readonly string[]
  now?: () => number
  request?: (url: string, init?: RequestInit) => Promise<Response>
}>

export function createHostedExecutionCapabilities(input: HostedExecutionCapabilitiesInput) {
  const reads = new WeakMap<WorkGraphContext, Promise<HostedCatalog>>()
  const catalog = (context: WorkGraphContext) => {
    const existing = reads.get(context)
    if (existing) return existing
    const pending = readHostedCatalog(input, context)
    reads.set(context, pending)
    void pending.catch(() => reads.delete(context))
    return pending
  }

  const capabilities = createExecutionCapabilitiesPort({
    environment: {
      kind: "hosted_workspace",
      repositoryRequired: false,
      remoteUrlInput: true,
      baseRevisionInput: true,
      isolation: ["stream"],
      cleanup: ["destroy_on_close"],
      integration: ["manual"],
    },
    readRuntime: async (context) => (await catalog(context)).runtime,
    readRepository: async () => ({ baseRevisions: [] }),
    readConnections: input.readConnections,
    connectionToolIds: input.connectionToolIds,
    ...(input.now ? { now: input.now } : {}),
  })
  return {
    ...capabilities,
    async probe(context: WorkGraphContext) {
      await provisionCatalogWorkspace(input, context)
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
  const workspaceId = await catalogWorkspaceId(context.ownerUserId)
  const placement = await input.sandboxManager.target(workspaceId)
  if (placement.status !== "ready") {
    throw new ExecutionCapabilitiesUnavailableError(
      "catalog_workspace",
      "catalog_workspace_unavailable",
      "The hosted capability catalog has not been discovered yet",
      false,
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
    const response = await (input.request ?? fetch)(
      `${relay.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(workspaceId)}${pathname}`,
      {
        headers: {
          authorization: `Bearer ${token.token}`,
          "x-opencode-directory": "/workspace",
          "accept-encoding": "identity",
        },
        signal: AbortSignal.timeout(5_000),
      },
    )
    if (!response.ok) throw new Error(`Hosted execution catalog ${pathname} failed with ${response.status}`)
    return response.json()
  }
  const [harness, agents, providers, tools] = await Promise.all([
    request("/session/capabilities?directory=%2Fworkspace"),
    request("/agent?directory=%2Fworkspace"),
    request("/provider"),
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

async function provisionCatalogWorkspace(input: HostedExecutionCapabilitiesInput, context: WorkGraphContext) {
  if (!input.auth(context)) {
    throw new ExecutionCapabilitiesUnavailableError(
      "catalog_workspace",
      "catalog_workspace_unavailable",
      "The signed owner context for hosted capability discovery is unavailable",
      false,
    )
  }
  const placement = await input.sandboxManager.ensure(await catalogWorkspaceId(context.ownerUserId), {
    homeRegion: input.defaultHomeRegion,
    runtimeCwd: "/workspace",
    labels: { workload: "workgraph-catalog", ownerUserId: context.ownerUserId },
    source: { kind: "empty" },
    exposure: { kind: "relay" },
  })
  if (placement.status === "provisioning") {
    throw new ExecutionCapabilitiesUnavailableError(
      "catalog_workspace",
      "runtime_unavailable",
      `The hosted capability catalog is provisioning; retry after ${placement.retryAfterMs}ms`,
      true,
    )
  }
  if (placement.status !== "ready") {
    throw new ExecutionCapabilitiesUnavailableError(
      "catalog_workspace",
      "runtime_unavailable",
      placement.error ?? "The hosted capability catalog runtime is unavailable",
      true,
    )
  }
}

async function catalogWorkspaceId(ownerUserId: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`workgraph-catalog:${ownerUserId}`))
  return `wg-catalog-${Array.from(new Uint8Array(digest).slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}
