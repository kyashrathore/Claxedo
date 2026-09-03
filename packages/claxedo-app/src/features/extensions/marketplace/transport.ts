import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { createAgentConfigAccountFetch } from "@/platform/account/agent-config-account-fetch"
import {
  centralTransportForServer,
  createTransport as defaultCreateTransport,
  unsignedLocalFetch as defaultUnsignedLocalFetch,
} from "@/platform/runtime/transport"
import { isRelayBackedWorkspaceKind, type WorkspaceKind } from "@/platform/runtime/agent/workspace-kind"
import {
  workspaceRuntimeRoutingRecord,
  type WorkspaceRecordScope,
} from "@/platform/runtime/workspace-runtime-record"
import {
  mcpExtensionUrl,
  workspaceRuntimeExtensionsPath,
  type ExtensionScope,
} from "./api"

/**
 * WHICH MACHINE answers an extensions request.
 *
 * `machine` and `project` scope are questions about a filesystem: whose
 * `~/.claude`, whose worktree. The marketplace used to ask them of
 * `getClaxedoServerUrl()` unconditionally, so a cloud or teammate-hosted pane
 * on the desktop scanned and mutated the laptop the app happens to run on, and
 * the same pane on the web asked a control plane that owns no machine at all.
 *
 * The owner is the machine serving the focused workspace, and the app already
 * knows how to reach it: resolve the workspace record for the directory
 * (`workspace-runtime-record.ts`), then take the same placement branch
 * `http-backend.ts` and `harness-config-runtime.ts` take — central for a local
 * workspace, the workspace's runtime transport for a relay-backed one.
 *
 * The two branches address different route families on purpose. Central is the
 * Claxedo server's `/api/claxedo/agent-config/extensions*`; a relayed caller
 * cannot use that path at all, because `user-hosted-surface.ts` denies the
 * whole `/api/claxedo` family across the host tunnel — those routes describe
 * the MACHINE, and a Runtime Access Token authorizes one workspace. The
 * relay-backed branch therefore asks the workspace surface,
 * `/api/wr/extensions*`, and the workspace identity rides the transport's own
 * `/workspaces/<id>/…` prefix.
 *
 * No workspace runtime implements that family yet, so today a cloud sandbox or
 * a teammate's host answers 404 and the panel says so (`MachineSection`'s
 * `unavailable`). That is the honest answer: machine-scope installs mutate a
 * home directory, and admitting them across a per-workspace tunnel is a trust
 * decision this module does not get to make on the host's behalf.
 */
export type MarketplaceExtensionsRequest = (input: {
  path?: string
  scope?: ExtensionScope
  directory?: string
  init?: RequestInit
}) => Promise<Response>

export type MarketplaceWorkspaceRef = {
  kind?: WorkspaceKind | null
  workspaceId?: string | null
}

type ResolveWorkspace = (input: WorkspaceRecordScope) => Promise<MarketplaceWorkspaceRef | null | undefined>

const resolveWorkspaceRecord: ResolveWorkspace = async (input) =>
  await workspaceRuntimeRoutingRecord(input)

export function createMarketplaceExtensionsRequest(input: {
  directory?: string
  serverUrl?: string
  request?: typeof fetch
  resolveWorkspace?: ResolveWorkspace
  createTransport?: typeof defaultCreateTransport
  unsignedLocalFetch?: typeof fetch
}): MarketplaceExtensionsRequest {
  const baseUrl = input.serverUrl ?? getClaxedoServerUrl()
  const resolveWorkspace = input.resolveWorkspace ?? resolveWorkspaceRecord
  const createTransport = input.createTransport ?? defaultCreateTransport
  const unsignedLocalFetch = input.unsignedLocalFetch ?? defaultUnsignedLocalFetch
  // Declare auth intent at the call site rather than inferring it from the URL
  // shape: a loopback Claxedo server bypasses the bearer, a remote control
  // plane uses the desktop AccountPort (or the injected browser fetch).
  const accountRequest = input.request ?? createAgentConfigAccountFetch(authFetch, baseUrl)
  const centralRequest = centralTransportForServer(baseUrl) === "loopback"
    ? unsignedLocalFetch
    : accountRequest

  // One resolve per panel: the record is routing identity, and a directory's
  // backing workspace does not change while the panel is open.
  let pending: Promise<MarketplaceWorkspaceRef | null | undefined> | undefined
  const workspace = () => {
    if (!input.directory) return Promise.resolve(undefined)
    pending ??= resolveWorkspace({ baseUrl, request: accountRequest, directory: input.directory })
      .catch(() => undefined)
    return pending
  }

  return async (params) => {
    const record = await workspace()
    const workspaceId = record?.workspaceId ?? undefined
    if (isRelayBackedWorkspaceKind(record?.kind) && workspaceId) {
      return await createTransport({
        placement: {
          workspaceId,
          hosting: "workspace",
          transport: centralTransportForServer(baseUrl) === "loopback" ? "loopback" : "workspace-relay",
        },
        serverUrl: baseUrl,
        ...(params.directory ? { directory: params.directory } : {}),
        request: accountRequest,
      }).fetch(
        workspaceRuntimeExtensionsPath(params.path, {
          ...(params.scope ? { scope: params.scope } : {}),
          ...(params.directory ? { directory: params.directory } : {}),
        }),
        params.init,
      )
    }
    return await centralRequest(
      mcpExtensionUrl(baseUrl, params.path, {
        ...(params.scope ? { scope: params.scope } : {}),
        ...(params.directory ? { directory: params.directory } : {}),
        ...(workspaceId ? { workspaceId } : {}),
      }).toString(),
      params.init,
    )
  }
}
