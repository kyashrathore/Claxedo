import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority, type WorkspaceRecord } from "@claxedo/server-core/platform/auth/authority"
import { resolveRuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"
import { WORKSPACE_RUNTIME_IDENTITY_PATH } from "@claxedo/server-core/platform/governance/route-ownership"
import { runtimeProviderCatalog } from "@claxedo/server-core/credentials/runtime-provider-catalog"
import type { RuntimeHarnessSelection } from "@claxedo/workspace-runtime/config"
import type { RelayRole } from "@claxedo/workspace-relay"
import { asRecord, asString } from "@claxedo/helpers/guards"
import type { ControlPlaneServices } from "../../authority/services"
import { resolveWorkspaceRuntimeTarget, WorkspaceRuntimeTargetError } from "../../authority/runtime-target"
import { relayRole } from "../../authority/pulled-session"
import { createRelayRuntimeClient, decodeRelayRuntimeJson } from "../../workspace/relay-runtime-client"

/** `/api/wr/health`'s shape, trimmed to the fields the harness probe reports. */
export type HostedHarnessProbe = {
  ok?: boolean
  status?: string
  harness?: RuntimeHarnessSelection
  activeHarness?: RuntimeHarnessSelection
  model?: string | null
  error?: string
  harnessHealth?: { status: "ok" | "degraded" | "unavailable"; reason?: string }
}

// Importing the generic session HTTP protocol reaches the desktop supervisor
// and runtime package, which cannot run in this Worker.
type HarnessRuntimeFetch = (input: { workspaceId: string; path: string }) => Promise<Response>

type HarnessTarget = {
  readonly workspaceId: string
  readonly orgId: string | undefined
  readonly workspace: WorkspaceRecord | undefined
  readonly role: RelayRole
}

type HarnessRuntime = { readonly json: (path: string) => Promise<unknown> }

function txt(input: unknown) {
  return typeof input === "string" ? input : undefined
}

/** The workspace the caller may open, with the role the relay grants them, or nothing when the authority refuses it. */
export async function openHarnessTarget(services: ControlPlaneServices, auth: SignedControlPlaneAuth, workspaceId: string): Promise<HarnessTarget | undefined> {
  const authority = requireAuthority(services)
  const opened = await authority.openWorkspace(auth, { workspaceId }).catch((err) => {
    if (err instanceof ControlPlaneAuthError) return undefined
    throw err
  })
  const role = relayRole(opened?.role)
  if (!opened || !role) return undefined
  const orgId = asString(opened.workspace?.org_id) ?? asString(await authority.resolveOrgId(auth))
  return { workspaceId, orgId, workspace: opened.workspace, role }
}

async function relayCapability(services: ControlPlaneServices, auth: SignedControlPlaneAuth, target: HarnessTarget) {
  const [targetRead, actorRead] = await Promise.allSettled([
    resolveWorkspaceRuntimeTarget(services, auth, { workspaceId: target.workspaceId, ...(target.workspace ? { workspace: target.workspace } : {}) }),
    resolveRuntimeActor(requireAuthority(services), auth),
  ])
  if (targetRead.status === "rejected") throw targetRead.reason
  if (actorRead.status === "rejected") throw actorRead.reason
  const runtime = targetRead.value
  const actor = actorRead.value
  const provider = services.relay.provider
  if (!provider) throw new Error("Workspace runtime pull transport is not configured")
  if (!target.orgId) throw new Error("Workspace is missing org identity for runtime token minting")
  return {
    provider,
    capability: {
      workspaceId: target.workspaceId,
      hostId: runtime.hostId,
      routingId: runtime.routingId,
      principalKind: "user" as const,
      auth,
      ...actor,
      orgId: target.orgId,
      role: target.role,
      ttlMs: 10 * 60_000,
      homeRegion: runtime.homeRegion,
    },
  }
}

/**
 * The workspace's runtime over the relay as the caller: its target and actor
 * are resolved once and one token is minted for every read made through it.
 */
async function connectHarnessRuntime(services: ControlPlaneServices, auth: SignedControlPlaneAuth, target: HarnessTarget, runtimeFetch: HarnessRuntimeFetch | undefined): Promise<HarnessRuntime> {
  const error = (_status: number, _code: string, message: string) => new Error(message)
  if (runtimeFetch) return { json: async (path) => await decodeRelayRuntimeJson(await runtimeFetch({ workspaceId: target.workspaceId, path }), error) }
  const { provider, capability } = await relayCapability(services, auth, target)
  return createRelayRuntimeClient({ provider, error }).connect(capability)
}

/**
 * A read answered by the runtime that serves the workspace asked about. The
 * identity is read beside the read itself, and the read's answer is used only
 * once the identity matches; a relay target that answers for another
 * workspace is not trusted with it.
 */
async function verifiedRuntimeJson(runtime: HarnessRuntime, workspaceId: string, path: string) {
  const [identity, answer] = await Promise.allSettled([runtime.json(WORKSPACE_RUNTIME_IDENTITY_PATH), runtime.json(path)])
  if (identity.status === "rejected") throw identity.reason
  if (txt(asRecord(identity.value)?.workspaceId) !== workspaceId) {
    throw new Error("Workspace runtime identity does not match requested workspace")
  }
  if (answer.status === "rejected") throw answer.reason
  return answer.value
}

function decodeHarnessSelection(input: unknown): RuntimeHarnessSelection | undefined {
  const row = asRecord(input)
  if (row?.kind === "connection" && typeof row.connectionId === "string" && row.connectionId.trim()) {
    return { kind: "connection", connectionId: row.connectionId }
  }
  if (row?.kind === "native" && (row.harnessId === "claude" || row.harnessId === "codex" || row.harnessId === "cursor" || row.harnessId === "pi")) {
    return { kind: "native", harnessId: row.harnessId }
  }
  return undefined
}

// `/api/wr/health`'s shape, read defensively the way every other hosted
// shape-mirror reads a runtime/authority payload: an untyped wire response,
// never a value this module minted itself.
function decodeSandboxHealth(input: unknown): HostedHarnessProbe {
  const row = asRecord(input)
  const health = asRecord(row?.harnessHealth)
  const healthStatus = health?.status
  return {
    ...(typeof row?.ok === "boolean" ? { ok: row.ok } : {}),
    ...(asString(row?.status) ? { status: asString(row?.status) } : {}),
    ...(decodeHarnessSelection(row?.harness) ? { harness: decodeHarnessSelection(row?.harness) } : {}),
    ...(decodeHarnessSelection(row?.activeHarness) ? { activeHarness: decodeHarnessSelection(row?.activeHarness) } : {}),
    ...(typeof row?.model === "string" || row?.model === null ? { model: row.model } : {}),
    ...(txt(row?.error) ? { error: txt(row?.error) } : {}),
    ...(healthStatus === "ok" || healthStatus === "degraded" || healthStatus === "unavailable"
      ? { harnessHealth: { status: healthStatus, ...(asString(health?.reason) ? { reason: asString(health?.reason) } : {}) } }
      : {}),
  }
}

export function hostedHarnessRuntimeStatus(
  services: ControlPlaneServices,
  /** Test seam only — production composition passes none and every fetch goes through the relay. */
  testOptions: { runtimeFetch?: HarnessRuntimeFetch } = {},
) {
  return async (auth: SignedControlPlaneAuth, input: { workspaceId: string; sessionId?: string }): Promise<HostedHarnessProbe | undefined> => {
    const target = await openHarnessTarget(services, auth, input.workspaceId)
    if (!target) return undefined
    try {
      const runtime = await connectHarnessRuntime(services, auth, target, testOptions.runtimeFetch)
      const path = input.sessionId ? `/api/wr/health?sessionId=${encodeURIComponent(input.sessionId)}` : "/api/wr/health"
      return decodeSandboxHealth(await verifiedRuntimeJson(runtime, target.workspaceId, path))
    } catch (err) {
      return { ok: false, status: "error", error: err instanceof Error ? err.message : String(err) }
    }
  }
}

export function hostedRuntimeProviderCatalog(services: ControlPlaneServices) {
  return async (auth: SignedControlPlaneAuth, workspaceId: string) => {
    const target = await openHarnessTarget(services, auth, workspaceId)
    if (!target || target.role !== "owner") throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "Workspace owner required")
    const runtime = await connectHarnessRuntime(services, auth, target, undefined).catch((error) => {
      if (error instanceof WorkspaceRuntimeTargetError && error.code === "cloud_runtime_unavailable") return undefined
      throw error
    })
    if (!runtime) return undefined
    return runtimeProviderCatalog.parse(await verifiedRuntimeJson(runtime, workspaceId, "/api/wr/harness-providers?nativeHarness=opencode"))
  }
}
