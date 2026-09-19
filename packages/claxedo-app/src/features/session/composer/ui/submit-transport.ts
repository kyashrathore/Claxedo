import { queryKeys } from "@/platform/query/keys"
import { getClaxedoServerUrl } from "@/platform/api/api"
import { declaredSessionAuthority, workspaceForDirectory, type ProjectCatalogItem } from "../workspace-resolver"
import { sessionHarnessIdentity, type HarnessType } from "@/features/session/harness/profile"
import { parseExistingSessionConfig } from "./submit-session-config"
import { createTransport } from "@/platform/runtime/transport"
import { harnessQueryFetch } from "@/platform/runtime/harness-query-fetch"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import type { SessionRef, WorkspaceSessionBacking } from "@/platform/identity/session-ref"
import type { HarnessSelection } from "@/platform/identity/harness-selection"
import { queryClient } from "@/platform/query/query-client"
import { sessionConfigRawQueryKey } from "../../store/session-config-selection"
import { setSessionConfigRawQueryData } from "../../store/session-config-query-cache"
import { createAgentRuntimeClient } from "@/platform/runtime/agent/agent-runtime-client"
import { requestWorkspaceRecord } from "@/platform/runtime/workspace-runtime-record"
import {
  centralTransportForServer,
  submitTransportForPlacement,
  unsignedLocalFetch,
} from "@/platform/runtime/transport"
import type { PromptDispatchInput, SubmitDirectory, SubmitSessionGetClient } from "../../submit/index"
import type { RelayHostKind } from "@/platform/runtime/placement-wire"

export type SubmitTransportClientFactoryInput = {
  readonly baseUrl: string
  readonly fetch: typeof fetch
  readonly directory: SubmitDirectory
  readonly throwOnError: true
}

export type SubmitTransportPlacementInput<Client extends PromptDispatchInput["client"] & SubmitSessionGetClient> = {
  readonly serverUrl: () => string
  readonly signedControlPlane: () => boolean | undefined
  /**
   * The project catalog this composer resolves against — the same rows that
   * name the workspace a signed submit reserves against, so "must I reserve"
   * and "reserve against what" are answered from one source.
   */
  readonly projects: () => readonly ProjectCatalogItem[]
  readonly workspaceId: () => string | undefined
  readonly hostKind: () => RelayHostKind | undefined
  readonly sessionRef?: () => SessionRef | undefined
  readonly request: typeof fetch
  readonly localRequest: typeof fetch
  readonly createClient: (input: SubmitTransportClientFactoryInput) => Client
  readonly showToast: (toast: { title: string; description?: string; variant?: "error" }) => void
  readonly formatError: (err: unknown) => string
  readonly text: {
    readonly configSaveFailedTitle: string
  }
}

export type SaveSessionConfigInput = SessionConfigPayload & {
  readonly sessionID: string
  readonly directory: SubmitDirectory
}

/** The persistable half of a session config: everything the PATCH body carries. */
type SessionConfigPayload = {
  readonly harnessType: HarnessType
  readonly agent?: string
  readonly model?: { providerID: string; modelID: string }
  readonly variant?: string
}

export function workspaceRuntimeRef(directory: SubmitDirectory | undefined) {
  if (!directory) return undefined
  const projects = queryClient.getQueryData<ProjectCatalogItem[]>(
    queryKeys.controlPlane.projects(getClaxedoServerUrl()),
  ) ?? []
  return sessionWorkspaceRuntimeRef({ directory, projects })
}

/**
 * The workspace a signed submit reserves against. The composer's accessor names
 * it when the route did; a session created in a workspace the route has not
 * named yet (a fresh cloud workspace, a `ws_…` directory) takes it from the
 * directory's runtime ref — the same owner finalize and the transport read.
 *
 * A workspace the signed server also serves from this machine has neither: its
 * catalog row is a plain local worktree at a filesystem directory, and only the
 * project catalog carries the id the control plane registered it under. That
 * row is the last resort, so a relay-backed workspace still resolves through
 * the runtime ref exactly as before.
 */
export function signedSubmitWorkspaceId(
  explicit: string | undefined,
  directory: SubmitDirectory | undefined,
  projects: readonly ProjectCatalogItem[] = [],
) {
  const catalogWorkspace = directory ? workspaceForDirectory(projects, directory) : undefined
  return explicit
    ?? workspaceRuntimeRef(directory)?.workspaceId
    ?? catalogWorkspace?.workspaceId
    ?? catalogWorkspace?.id
    ?? undefined
}

export function submitWorkspaceBacking(input: {
  sessionRef?: SessionRef
  workspaceId?: string
  hostKind?: WorkspaceSessionBacking["kind"]
}): WorkspaceSessionBacking | undefined {
  const sandbox = input.sessionRef?.toolSandbox
  if (sandbox?.kind === "workspace") {
    return {
      workspaceId: sandbox.workspaceId,
      kind: sandbox.hosting,
      ...(sandbox.hostId ? { hostId: sandbox.hostId } : {}),
    }
  }
  const workspaceId = input.workspaceId?.trim()
  if (!workspaceId || !input.hostKind) return undefined
  return { workspaceId, kind: input.hostKind }
}

export function createSubmitTransportAdapter<Client extends PromptDispatchInput["client"] & SubmitSessionGetClient>(
  input: SubmitTransportPlacementInput<Client>,
) {
  const runtimeTransport = (dir: SubmitDirectory) => {
    const sessionAuthority = declaredSessionAuthority(workspaceForDirectory(input.projects(), dir))
    return submitTransportForPlacement({
      serverUrl: input.serverUrl(), directory: dir, signedControlPlane: input.signedControlPlane(),
      ...(sessionAuthority ? { sessionAuthority } : {}),
      workspaceId: input.workspaceId(), hostKind: input.hostKind(),
    })
  }

  const localSessionFetch = (dir: SubmitDirectory) =>
    runtimeTransport(dir).loopbackWorkspaceBridge
      ? unsignedLocalFetch
      : input.localRequest

  const usesSignedControlPlane = (dir: SubmitDirectory) =>
    runtimeTransport(dir).controlPlaneSession

  const usesManagedSessionRegistration = (dir: SubmitDirectory) =>
    runtimeTransport(dir).managedSessionRegistration

  const usesLoopbackWorkspaceBridge = (dir: SubmitDirectory) =>
    runtimeTransport(dir).loopbackWorkspaceBridge

  const runtimeSessionFetch = (dir: SubmitDirectory): typeof fetch => {
    const ref = workspaceRuntimeRef(dir)
    const workspaceId = input.workspaceId() ?? ref?.workspaceId
    return createTransport({
      placement: {
        ...(workspaceId ? { workspaceId } : {}),
        hosting: "workspace",
        transport: workspaceId && (input.signedControlPlane() || centralTransportForServer(input.serverUrl()) !== "loopback")
          ? "workspace-relay"
          : "loopback",
      },
      serverUrl: input.serverUrl(),
      directory: dir,
      request: input.request,
      relayRequest: input.request,
      resolveWorkspaceRuntime: ({ directory }) =>
        requestWorkspaceRecord({ baseUrl: input.serverUrl(), directory, request: input.request }),
    }).sdkFetch
  }

  const usesWorkspaceRuntimeSession = (dir: SubmitDirectory) => runtimeTransport(dir).workspaceRuntimeSession
  const sessionFetch = (dir: SubmitDirectory) => usesWorkspaceRuntimeSession(dir) ? runtimeSessionFetch(dir) : localSessionFetch(dir)

  const sessionRequest = (dir: SubmitDirectory, path: string, init?: RequestInit) =>
    sessionFetch(dir)(usesWorkspaceRuntimeSession(dir) ? path : `${input.serverUrl()}${path}`, init)

  const sessionClient = (dir: string, harnessType?: HarnessSelection) =>
    input.createClient({
      baseUrl: input.serverUrl(),
      fetch: harnessQueryFetch({
        request: sessionFetch(dir),
        harnessType,
      }),
      directory: dir,
      throwOnError: true,
    })

  const createRuntimePromptClient = (clientInput: {
    readonly signedControlPlane: boolean
    readonly sessionDirectory: SubmitDirectory
    readonly sessionRef: SessionRef | undefined
  }) => {
    const runtimeClient = createAgentRuntimeClient({
      serverUrl: input.serverUrl(),
      request: clientInput.signedControlPlane || workspaceRuntimeRef(clientInput.sessionDirectory)
        ? input.request
        : localSessionFetch(clientInput.sessionDirectory),
      signedControlPlane: clientInput.signedControlPlane,
      sessionRef: clientInput.sessionRef,
      workspaceId: input.workspaceId(),
      hostKind: input.hostKind(),
    })
    const runtimePromptClient: PromptDispatchInput["client"] = {
      session: {
        promptAsync: (payload) => runtimeClient.sendMessage(payload),
      },
    }
    return {
      ...runtimePromptClient,
      // Wrapped rather than passed bare: both are methods on the agent runtime
      // client, so detaching them from their receiver is unsound.
      getGoalCapabilities: (goalInput: Parameters<typeof runtimeClient.getGoalCapabilities>[0]) =>
        runtimeClient.getGoalCapabilities(goalInput),
      startGoal: (goalInput: Parameters<typeof runtimeClient.startGoal>[0]) => runtimeClient.startGoal(goalInput),
      replaceQueuedMessage: (replaceInput: Parameters<typeof runtimeClient.replaceQueuedMessage>[0]) =>
        runtimeClient.replaceQueuedMessage(replaceInput),
    }
  }

  const persistSessionConfig = async (configInput: SaveSessionConfigInput) => {
    const body = sessionConfigBody(configInput)
    const next = JSON.stringify(body)
    const path = sessionConfigPath(configInput)
    const res = await sessionRequest(configInput.directory, path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: next,
    })
    if (!res.ok) throw new Error((await res.text().catch(() => "")) || `session config save failed: ${res.status}`)
    setSessionConfigRawQueryData({
      sessionID: configInput.sessionID,
      directory: configInput.directory,
      workspaceId: input.workspaceId(),
      sessionRef: input.sessionRef?.(),
      serverUrl: input.serverUrl(),
    }, await res.json())
  }

  const saveSessionConfig = async (configInput: SaveSessionConfigInput) => {
    const queryKey = sessionConfigRawQueryKey({
      sessionID: configInput.sessionID,
      directory: configInput.directory,
      workspaceId: input.workspaceId(),
      sessionRef: input.sessionRef?.(),
      serverUrl: input.serverUrl(),
    })
    if (
      sessionConfigSignature(queryClient.getQueryData(queryKey)) ===
      JSON.stringify(sessionConfigBody(configInput))
    ) return
    try {
      await persistSessionConfig(configInput)
    } catch (err) {
      input.showToast({
        title: input.text.configSaveFailedTitle,
        description: input.formatError(err),
        variant: "error",
      })
    }
  }

  const readSessionConfig = async (configInput: Pick<SaveSessionConfigInput, "sessionID" | "directory">) => {
    const queryKey = sessionConfigRawQueryKey({
      sessionID: configInput.sessionID,
      directory: configInput.directory,
      workspaceId: input.workspaceId(),
      sessionRef: input.sessionRef?.(),
      serverUrl: input.serverUrl(),
    })
    const cached = queryClient.getQueryData(queryKey)
    if (cached !== undefined) return cached
    return await queryClient.fetchQuery({
      queryKey,
      queryFn: async () => {
        const res = await sessionRequest(configInput.directory, sessionConfigPath(configInput), {
          headers: { Accept: "application/json" },
        })
        if (!res.ok) throw new Error((await res.text().catch(() => "")) || `session config read failed: ${res.status}`)
        return await res.json()
      },
    })
  }

  return {
    localSessionFetch,
    usesSignedControlPlane,
    usesManagedSessionRegistration,
    usesLoopbackWorkspaceBridge,
    usesWorkspaceRuntimeSession,
    sessionClient,
    createRuntimePromptClient,
    readSessionConfig,
    saveSessionConfig,
  }
}

function sessionConfigBody(input: SessionConfigPayload) {
  return {
    harness: sessionHarnessIdentity(input.harnessType),
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.variant ? { variant: input.variant } : {}),
  }
}

function sessionConfigPath(input: Pick<SaveSessionConfigInput, "sessionID" | "directory">) {
  const url = new URL(`/session/${encodeURIComponent(input.sessionID)}/config`, "http://claxedo.local")
  url.searchParams.set("directory", input.directory)
  return `${url.pathname}${url.search}`
}

/** Compare cached configuration and writes using the same canonical PATCH representation. */
function sessionConfigSignature(input: unknown) {
  const parsed = parseExistingSessionConfig(input)
  if (!parsed) return undefined
  return JSON.stringify(sessionConfigBody(parsed))
}
