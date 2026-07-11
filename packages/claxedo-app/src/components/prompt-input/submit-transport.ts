import { selectRuntimeModel } from "@/session/composer/model-strategy"
import { shellDataKeys } from "../../shell/data/keys"
import { createTransport } from "../../shell/data/transport/transport"
import { harnessQueryFetch } from "../../shell/data/transport/harness-query-fetch"
import { sessionWorkspaceRuntimeRef } from "../../shell/workspace/session-workspace-key"
import type { SessionRef } from "../../shell/identity/session-ref"
import { queryClient } from "../../shared/query/query-client"
import { createAgentRuntimeClient } from "../../agent-runtime/agent-runtime-client"
import { resolveSessionUrl } from "../../utils/session-url"
import { workspaceResolveUrl } from "../../utils/workspace-control-routes"
import {
  centralTransportForServer,
  submitTransportForPlacement,
  unsignedLocalFetch,
} from "@/shell/data/transport/transport"
import type { PromptDispatchInput, SubmitDirectory, SubmitModel, SubmitSessionGetClient } from "../../session/submit"

const savedSessionConfigQueryPart = "saved-config-signature"

export function savedSessionConfigQueryKey(sessionID: string) {
  return shellDataKeys.sessionId(sessionID, savedSessionConfigQueryPart)
}

/** Test-only: clear the session-config dedup cache. */
export function _resetSavedSessionConfigCacheForTest() {
  queryClient.removeQueries({
    predicate: (query) => query.queryKey[0] === "shell" && query.queryKey[3] === savedSessionConfigQueryPart,
  })
}

export type SubmitTransportClientFactoryInput = {
  readonly baseUrl: string
  readonly fetch: typeof fetch
  readonly directory: SubmitDirectory
  readonly throwOnError: true
}

export type SubmitTransportPlacementInput<Client extends PromptDispatchInput["client"] & SubmitSessionGetClient> = {
  readonly serverUrl: () => string
  readonly signedControlPlane: () => boolean | undefined
  readonly workspaceId: () => string | undefined
  readonly workspaceKind: () => "cloud" | "user-hosted" | undefined
  readonly request: typeof fetch
  readonly localRequest: typeof fetch
  readonly config: Parameters<typeof resolveSessionUrl>[1]
  readonly createClient: (input: SubmitTransportClientFactoryInput) => Client
  readonly showToast: (toast: { title: string; description?: string; variant?: "error" }) => void
  readonly formatError: (err: unknown) => string
  readonly text: {
    readonly configSaveFailedTitle: string
  }
}

export type SaveSessionConfigInput = {
  readonly sessionID: string
  readonly directory: SubmitDirectory
  readonly harnessType: string
  readonly agent?: string
  readonly model?: { providerID: string; modelID: string }
  readonly variant?: string
}

export function workspaceRuntimeRef(directory: SubmitDirectory | undefined) {
  return directory ? sessionWorkspaceRuntimeRef({ directory }) : undefined
}

export function createSubmitTransportAdapter<Client extends PromptDispatchInput["client"] & SubmitSessionGetClient>(
  input: SubmitTransportPlacementInput<Client>,
) {
  const runtimeTransport = (dir: SubmitDirectory) => submitTransportForPlacement({
    serverUrl: input.serverUrl(), directory: dir, signedControlPlane: input.signedControlPlane(),
    workspaceId: input.workspaceId(), workspaceKind: input.workspaceKind(),
  })

  const localSessionFetch = (dir: SubmitDirectory) =>
    runtimeTransport(dir).loopbackWorkspaceBridge
      ? unsignedLocalFetch
      : input.localRequest

  const usesSignedControlPlane = (dir: SubmitDirectory) =>
    runtimeTransport(dir).controlPlaneSession

  const usesLoopbackWorkspaceBridge = (dir: SubmitDirectory) =>
    runtimeTransport(dir).loopbackWorkspaceBridge

  const runtimeSessionFetch = (dir: SubmitDirectory): typeof fetch => {
    const ref = workspaceRuntimeRef(dir)
    return createTransport({
      placement: {
        ...(ref?.workspaceId ? { workspaceId: ref.workspaceId } : {}),
        hosting: "workspace",
        transport: ref?.workspaceId && centralTransportForServer(input.serverUrl()) !== "loopback" ? "workspace-relay" : "loopback",
      },
      serverUrl: input.serverUrl(),
      directory: dir,
      request: input.request,
      relayRequest: input.request,
      resolveWorkspaceRuntime: async ({ directory }) => {
        const res = await input.request(workspaceResolveUrl({ baseUrl: input.serverUrl(), scope: directory }), {
          headers: { Accept: "application/json" },
        })
        if (res.status === 404) return null
        if (!res.ok) throw new Error((await res.text()) || `workspace resolve failed: ${res.status}`)
        return await res.json()
      },
    }).sdkFetch
  }

  const usesWorkspaceRuntimeSession = (dir: SubmitDirectory) =>
    runtimeTransport(dir).workspaceRuntimeSession

  const sessionFetch = (dir: SubmitDirectory) =>
    usesWorkspaceRuntimeSession(dir) ? runtimeSessionFetch(dir) : localSessionFetch(dir)

  const sessionRequest = (dir: SubmitDirectory, path: string, init?: RequestInit) =>
    sessionFetch(dir)(usesWorkspaceRuntimeSession(dir) ? path : `${input.serverUrl()}${path}`, init)

  const modelForSubmit = async (dir: SubmitDirectory, selected: SubmitModel | undefined) => {
    if (!workspaceRuntimeRef(dir)) return selected
    if (centralTransportForServer(input.serverUrl()) === "loopback") {
      return selected ?? { id: "big-pickle", provider: { id: "opencode" } }
    }
    const res = await sessionRequest(dir, opencodeProviderPath({
      directory: dir,
      harnessType: "opencode",
    }), {
      headers: { Accept: "application/json" },
    }).catch(() => undefined)
    if (!res?.ok) return selected
    const body = await res.json().catch(() => undefined)
    return selectRuntimeModel(body, selected) ?? selected
  }

  const sessionClient = (dir: string, harnessType?: string) =>
    input.createClient({
      baseUrl: input.serverUrl(),
      fetch: harnessQueryFetch({
        request: sessionFetch(dir),
        harnessType,
      }),
      directory: dir,
      throwOnError: true,
    })

  const hostedSessionClient = async (dir: string, sessionID: string) => {
    if (runtimeTransport(dir).loopbackWorkspaceBridge) return
    const url = await resolveSessionUrl(sessionID, input.config)
    if (!url) return
    return input.createClient({
      baseUrl: url,
      fetch: input.localRequest,
      directory: dir,
      throwOnError: true,
    })
  }

  const createRuntimePromptClient = (clientInput: {
    readonly signedControlPlane: boolean
    readonly sessionDirectory: SubmitDirectory
    readonly sessionRef: SessionRef | undefined
    readonly opencodeClient: PromptDispatchInput["client"]
  }) => {
    const runtimeClient = createAgentRuntimeClient({
      serverUrl: input.serverUrl(),
      request: clientInput.signedControlPlane || workspaceRuntimeRef(clientInput.sessionDirectory)
        ? input.request
        : localSessionFetch(clientInput.sessionDirectory),
      signedControlPlane: clientInput.signedControlPlane,
      sessionRef: clientInput.sessionRef,
      opencodeClient: clientInput.opencodeClient,
    })
    const runtimePromptClient: typeof clientInput.opencodeClient = {
      session: {
        prompt: (payload: Parameters<typeof clientInput.opencodeClient.session.prompt>[0]) =>
          runtimeClient.sendMessage({ ...payload, mode: "sync" }) as ReturnType<typeof clientInput.opencodeClient.session.prompt>,
        promptAsync: (payload: Parameters<typeof clientInput.opencodeClient.session.promptAsync>[0]) =>
          runtimeClient.sendMessage({ ...payload, mode: "async" }),
      },
    }
    return runtimePromptClient
  }

  const saveSessionConfig = async (configInput: SaveSessionConfigInput) => {
    const body = {
      harness: {
        type: configInput.harnessType,
      },
      ...(configInput.agent ? { agent: configInput.agent } : {}),
      ...(configInput.model ? { model: configInput.model } : {}),
      ...(configInput.variant ? { variant: configInput.variant } : {}),
    }
    // Rubric C1: skip the PATCH when the submitted config matches the
    // last value persisted for this session. Saves one RTT per prompt on
    // the common "user typed and hit enter without changing model/agent"
    // path, which is most prompts in a session. The signature is session
    // scoped so model swaps still PATCH when the value actually changed.
    const next = JSON.stringify(body)
    const queryKey = savedSessionConfigQueryKey(configInput.sessionID)
    if (queryClient.getQueryData<string>(queryKey) === next) return
    const url = new URL(`/session/${encodeURIComponent(configInput.sessionID)}/config`, "http://claxedo.local")
    url.searchParams.set("directory", configInput.directory)
    url.searchParams.set("harness", configInput.harnessType)
    try {
      const res = await sessionRequest(configInput.directory, `${url.pathname}${url.search}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: next,
      })
      if (!res.ok) throw new Error((await res.text().catch(() => "")) || `session config save failed: ${res.status}`)
      queryClient.setQueryData(queryKey, next)
    } catch (err) {
      input.showToast({
        title: input.text.configSaveFailedTitle,
        description: input.formatError(err),
        variant: "error",
      })
    }
  }

  return {
    localSessionFetch,
    usesSignedControlPlane,
    usesLoopbackWorkspaceBridge,
    usesWorkspaceRuntimeSession,
    modelForSubmit,
    sessionClient,
    hostedSessionClient,
    createRuntimePromptClient,
    saveSessionConfig,
  }
}

function opencodeProviderPath(input: { directory?: string; harnessType?: string }) {
  const url = new URL("/provider", "http://claxedo.local")
  if (input.directory) url.searchParams.set("directory", input.directory)
  if (input.harnessType) url.searchParams.set("harness", input.harnessType)
  return `${url.pathname}${url.search}`
}
