import type { SessionPromptResponse, Todo } from "@opencode-ai/sdk/v2/client"
import { apiBearerToken, authFetch } from "@/platform/api/api"
import { createControlPlaneAccountFetch } from "@/platform/account/control-plane-account-fetch"
import { AgentRuntimeRequestError, runtimeRequestError } from "./agent-runtime-request-error"
import type { SessionTransportCapabilities } from "@/platform/runtime/capabilities"
import { supportsSessionDirectory, type SessionRef } from "@/platform/identity/session-ref"
import { harnessSelectionQuery, type HarnessSelection } from "@/platform/identity/harness-selection"
import { usesScopedSessionTransport, workspaceIdFromRef } from "@/platform/identity/legacy-resolver"
import { queryClient } from "@/platform/query/query-client"
import { fastSessionSwitchAnyNetworkQuiet } from "@/platform/runtime/session-switch"
import type {
  AgentRuntimeMessageRow,
  AgentRuntimeMessagesPage,
  AgentRuntimePermissionMode,
  AgentRuntimePermissionModeState,
  AgentRuntimePromptPayload,
  RuntimeSession,
  SessionMessagePageRequest,
} from "@/platform/runtime/session"
import {
  controlSessionListUrl,
  workspaceResolveUrl,
} from "@/platform/runtime/agent/workspace-control-routes"
import { centralTransportForServer, createTransport } from "@/platform/runtime/transport"
import { workspaceKind } from "@/platform/runtime/agent/workspace-kind"
import {
  resolveRuntimePlacement,
  resolveSessionResourceRoute,
} from "@/platform/runtime/agent/placement-table"
import { centralRuntimePath } from "./central-runtime-path"
import { createAgentRuntimeGoalClient } from "./agent-runtime-goal-client"
import { readRuntimeJson as readJson } from "./agent-runtime-json"
import {
  agentRuntimeBaseUrl,
  agentRuntimeSessionListUrl,
  agentRuntimeSessionResourceUrl,
  agentRuntimeSessionUrl,
  normalizedAgentRuntimeServerUrl,
  type AgentRuntimeDirectory,
  type AgentRuntimeSessionResource,
} from "./agent-runtime-urls"
import { requestName, sessionPerf } from "@/platform/performance/session-perf"
export { centralRuntimePath } from "./central-runtime-path"
export type { AgentRuntimeDirectory } from "./agent-runtime-urls"
export type {
  AgentRuntimeGoalAction,
  AgentRuntimeGoalCapabilities,
  AgentRuntimeGoalMutationResult,
  AgentRuntimeGoalOptionalField,
} from "./agent-runtime-goal-client"
export type {
  AgentRuntimeMessageRow,
  AgentRuntimeMessagesPage,
  AgentRuntimePermissionMode,
  AgentRuntimePermissionModeState,
  AgentRuntimePromptPayload,
} from "@/platform/runtime/session"

export type AgentRuntimeSessionCreateInput = {
  directory: AgentRuntimeDirectory
  harness: HarnessSelection
  agent: string
  model: PromptModel
  variant?: string
  headers?: Record<string, string>
}

export type AgentRuntimeOpenCodeClient = {
  session: {
    create?: (input: { directory: AgentRuntimeDirectory }, init?: { headers?: Record<string, string> }) => Promise<{ data?: RuntimeSession; error?: unknown }>
    get?: (input: { sessionID: string }) => Promise<{ data?: RuntimeSession }>
    messages?: (input: {
      sessionID: string
      directory?: string
    } & SessionMessagePageRequest, options?: { signal?: AbortSignal }) => Promise<{ data?: AgentRuntimeMessageRow[]; response: Response }>
    todo?: (input: { sessionID: string }) => Promise<{ data?: Todo[] }>
    prompt?: (input: AgentRuntimePromptPayload) => Promise<{ data?: SessionPromptResponse; error?: unknown }>
    promptAsync?: (input: AgentRuntimePromptPayload) => Promise<unknown>
    abort?: (input: { sessionID: string }) => Promise<unknown>
  }
}

export const DEFAULT_AGENT_RUNTIME_CAPABILITIES: SessionTransportCapabilities = {
  transport: "opencode",
  abort: true,
  reconnect: false,
  replay: true,
  permissions: true,
  questions: true,
  todos: true,
  commands: true,
  fork: true,
  revert: true,
  unrevert: true,
  configOptions: false,
  goals: true,
}

export function agentRuntimeWorkspaceTargetQueryKey(input: { serverUrl?: string; directory: AgentRuntimeDirectory }) {
  return ["shell", "agent-runtime-workspace-target", normalizedAgentRuntimeServerUrl(input.serverUrl), input.directory] as const
}

function ordinal(data: unknown, response: Response) {
  if (data && typeof data === "object" && "maxEventOrdinal" in data) {
    const value = data.maxEventOrdinal
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  const header = response.headers.get("x-max-event-ordinal")
  const value = header === null ? Number.NaN : Number(header)
  if (Number.isFinite(value)) return value
  throw new AgentRuntimeRequestError("Session history omitted maxEventOrdinal", 502, "invalid_response")
}

function messageRows(input: unknown): Array<{ info: AgentPresentationMessage; parts?: AgentContentPart[] }> {
  if (Array.isArray(input)) {
    return input
  }
  if (input && typeof input === "object" && "messages" in input && Array.isArray(input.messages)) {
    return input.messages
  }
  throw new AgentRuntimeRequestError("Session history response omitted messages", 502, "invalid_response")
}

function sessionRows(input: unknown): AgentPresentationSession[] {
  if (input && typeof input === "object" && "sessions" in input && Array.isArray(input.sessions)) {
    return input.sessions
  }
  throw new AgentRuntimeRequestError("Session list response omitted sessions", 502, "invalid_response")
}

function createdSession(input: unknown): AgentSession {
  if (!input || typeof input !== "object" || !("id" in input) || typeof input.id !== "string" || !input.id) {
    throw new AgentRuntimeRequestError("Session create response omitted the canonical session id", 502, "invalid_response")
  }
  return { id: input.id }
}

function deleteResult(input: unknown): { ok: true } {
  if (!input || typeof input !== "object" || !("ok" in input) || input.ok !== true) {
    throw new AgentRuntimeRequestError("Session delete response omitted confirmation", 502, "invalid_response")
  }
  return { ok: true }
}

function jsonInit(method: "POST" | "PATCH" | "PUT", body?: unknown, init?: RequestInit): RequestInit {
  return {
    ...init,
    method,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : init?.headers),
    },
    body: JSON.stringify(body ?? {}),
  }
}

export function createAgentRuntimeClient(options: {
  serverUrl?: string
  request?: typeof fetch
  signedControlPlane?: boolean
  sessionRef?: SessionRef
  workspaceId?: string
  // The workspace's REAL hosting kind (cloud vs user-hosted), resolved by the pane's
  // connection authority from the signed inventory. Threaded down so `workspaceTarget`
  // can label early-resolved targets — without it a user-hosted workspace whose
  // `directory` is a filesystem path (the registration-stored remote_directory) is
  // indistinguishable from signed-cloud and session reads 404 on the central control
  // plane. `workspaceReachable` is its runtime liveness (resolveSessionResourceRoute).
  workspaceKind?: "cloud" | "user-hosted"; workspaceReachable?: boolean
} = {}) {
  const request = options.request ?? createControlPlaneAccountFetch(authFetch)
  const signed = options.signedControlPlane === true
  const serverUrl = () => options.serverUrl?.trim() || undefined

  // Attach the caller-resolved hosting kind (when known) so downstream routing
  // sees a CONFIRMED kind instead of guessing from the directory shape.
  function knownKindTarget(workspaceId: string) {
    const kind = options.workspaceKind
    return {
      workspaceId,
      ...(kind ? { workspace: { workspaceId, kind } } : {}),
    }
  }

  async function workspaceTarget(directory: AgentRuntimeDirectory, targetOptions?: { forceResolve?: boolean }) {
    if (options.sessionRef?.toolSandbox?.kind === "workspace") {
      return {
        workspaceId: options.sessionRef.toolSandbox.workspaceId,
        workspace: {
          workspaceId: options.sessionRef.toolSandbox.workspaceId,
          kind: options.sessionRef.toolSandbox.hosting,
        },
      }
    }
    if (options.sessionRef?.workspaceId) return knownKindTarget(options.sessionRef.workspaceId)
    if (options.workspaceId) return knownKindTarget(options.workspaceId)
    const directoryWorkspaceId = workspaceIdFromRef(directory)
    if (directoryWorkspaceId) {
      // A `ws_`/`workspace:ws_` directory-ref tells us the workspace is
      // relay-backed, but NOT whether it is cloud or user-hosted (the ref shape
      // is identical for both). Do NOT assert `kind: "cloud"` here — that guess
      // mislabels user-hosted workspaces and forces `fetchSessionResource` onto
      // the central control plane (404, since user-hosted has no control-plane
      // session store). Leave the kind unresolved so the relay divert fires for
      // anything that isn't a *confirmed* cloud workspace (confirmed only by the
      // sessionRef.toolSandbox.hosting or the workspace resolve response kind.
      // A caller-resolved `workspaceKind` IS a confirmation — attach it.
      return knownKindTarget(directoryWorkspaceId)
    }
    if (!targetOptions?.forceResolve && fastSessionSwitchAnyNetworkQuiet()) return {
      workspaceId: undefined,
      workspace: undefined,
    }
    return await queryClient.fetchQuery({
      queryKey: agentRuntimeWorkspaceTargetQueryKey({ serverUrl: serverUrl(), directory }),
      queryFn: async () => {
        const res = await request(
          workspaceResolveUrl({ baseUrl: serverUrl(), scope: directory }),
          await signedControlPlaneInit(),
        )
        const body = await readJson<{ workspaceId?: string; kind?: unknown }>(res)
        if (!body?.workspaceId) throw new Error(`Signed session transport requires a workspace id for ${directory}`)
        return {
          workspaceId: body.workspaceId,
          ...(workspaceKind(body.kind)
            ? { workspace: { workspaceId: body.workspaceId, kind: workspaceKind(body.kind) } }
            : {}),
        }
      },
      staleTime: Number.POSITIVE_INFINITY,
    })
  }

  function placementServerContext() {
    return { serverUrl: serverUrl(), baseUrl: agentRuntimeBaseUrl(serverUrl()) }
  }

  function runtimeTransport(input: {
    directory?: string
    sessionRef?: SessionRef
    workspaceId?: string
    preferRelayOnLoopback?: boolean
  }) {
    return createTransport({
      placement: resolveRuntimePlacement(input, placementServerContext()),
      serverUrl: serverUrl(),
      directory: input.directory,
      request,
      relayRequest: request,
    })
  }

  async function workspaceId(directory: AgentRuntimeDirectory) {
    return (await workspaceTarget(directory)).workspaceId
  }

  async function fetchPath(directory: AgentRuntimeDirectory, url: URL, init?: RequestInit) {
    if (!signed && options.sessionRef) {
      return await runtimeTransport({
        directory,
        sessionRef: options.sessionRef,
      }).fetch(`${url.pathname}${url.search}`, init)
    }
    if (!signed && workspaceIdFromRef(directory)) {
      const target = await workspaceTarget(directory)
      return await runtimeTransport({
        directory,
        workspaceId: target.workspaceId,
      }).fetch(`${url.pathname}${url.search}`, init)
    }
    return await request(url, init)
  }

  async function fetchSessionResource(input: {
    sessionID: string
    directory: AgentRuntimeDirectory
    resource?: AgentRuntimeSessionResource
    query?: Record<string, string | number | undefined>
    init?: RequestInit
  }) {
    if (!supportsSessionDirectory({ directory: input.directory, sessionRef: options.sessionRef })) throw new Error("Directory-less central sessions require the Pi harness")
    const init = await signedControlPlaneInit(input.init)
    const target = signed ? await workspaceTarget(input.directory) : undefined
    const directoryWorkspaceId = workspaceIdFromRef(input.directory) ?? (!signed ? options.workspaceId : undefined)
    const runtimeUrl = agentRuntimeSessionResourceUrl({
      serverUrl: serverUrl(),
      sessionID: input.sessionID,
      directory: input.directory,
      resource: input.resource,
      query: input.query,
    })
    const runtimePath = `${runtimeUrl.pathname}${runtimeUrl.search}`
    const route = resolveSessionResourceRoute({
      signed,
      hasSessionRef: !!options.sessionRef,
      targetWorkspaceId: target?.workspaceId,
      targetKind: workspaceKind(target?.workspace?.kind),
      directoryWorkspaceId: directoryWorkspaceId ?? undefined,
      resource: input.resource,
      loopback: centralTransportForServer(agentRuntimeBaseUrl(serverUrl())) === "loopback",
      targetReachable: options.workspaceReachable,
    })
    const span = sessionPerf.span("request.session", {
      via: route.via,
      resource: input.resource ?? "session",
      sessionId: input.sessionID,
      method: init?.method?.toUpperCase() ?? "GET",
      url: requestName(runtimeUrl),
    })
    try {
      const response = await sessionResourceResponse()
      span.end({ status: response.status, ok: response.ok })
      return response
    } catch (error) {
      span.end({ ok: false, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
    async function sessionResourceResponse() {
    switch (route.via) {
      case "runtime-session-ref":
        return await runtimeTransport({
          directory: input.directory,
          sessionRef: options.sessionRef,
        }).fetch(centralRuntimePath(runtimePath, options.sessionRef), init)
      case "runtime-workspace":
        return await runtimeTransport({
          directory: input.directory,
          workspaceId: route.workspaceId,
          ...(route.preferRelayOnLoopback ? { preferRelayOnLoopback: true } : {}),
        }).fetch(runtimePath, init)
      case "control-plane":
        return await request(agentRuntimeSessionResourceUrl({
          serverUrl: serverUrl(),
          signedControlPlane: true,
          workspaceId: target?.workspaceId,
          sessionID: input.sessionID,
          directory: input.directory,
          resource: input.resource,
          query: input.query,
        }), init)
      case "direct":
        return await request(runtimeUrl, init)
    }
    }
  }

  // Bearer from the build's bound source, not the provider — see `apiBearerToken`.
  async function controlPlaneAuthInit(init?: RequestInit) {
    const headers = new Headers(init?.headers)
    if (!headers.has("Authorization")) {
      const token = await apiBearerToken()
      if (token) headers.set("Authorization", `Bearer ${token}`)
    }
    return { ...init, headers }
  }

  async function signedControlPlaneInit(init?: RequestInit) {
    if (!signed) return init
    return await controlPlaneAuthInit(init)
  }

  async function fetchRuntimePath(input: { directory: AgentRuntimeDirectory; path: string; init?: RequestInit }) {
    if (!supportsSessionDirectory({ directory: input.directory, sessionRef: options.sessionRef })) throw new Error("Directory-less central sessions require the Pi harness")
    const init = await signedControlPlaneInit(input.init)
    const method = init?.method?.toUpperCase() ?? "GET"
    const target = signed || options.sessionRef?.toolSandbox?.kind === "workspace" || options.sessionRef?.workspaceId || options.workspaceId || workspaceIdFromRef(input.directory)
      ? await workspaceTarget(input.directory, { forceResolve: method !== "GET" && method !== "HEAD" })
      : undefined
    const sessionRef = signed && target?.workspaceId ? undefined : options.sessionRef
    const span = sessionPerf.span("request.runtime", {
      method,
      path: input.path.split("?")[0] ?? input.path,
      ...(target?.workspaceId ? { workspaceId: target.workspaceId } : {}),
      ...(target?.workspace?.kind ? { workspaceKind: String(target.workspace.kind) } : {}),
    })
    try {
      const response = await runtimeTransport({
        directory: input.directory,
        sessionRef,
        workspaceId: target?.workspaceId,
        preferRelayOnLoopback: signed,
      }).fetch(centralRuntimePath(input.path, sessionRef), init)
      span.end({ status: response.status, ok: response.ok, url: requestName(response.url || input.path) })
      return response
    } catch (error) {
      span.end({ ok: false, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  async function fetchRuntimeSession(input: {
    sessionID: string
    directory: AgentRuntimeDirectory
    suffix?: string
    query?: Record<string, string | number | undefined>
    init?: RequestInit
  }) {
    const url = agentRuntimeSessionUrl({
      serverUrl: serverUrl(),
      sessionID: input.sessionID,
      suffix: input.suffix,
    })
    url.searchParams.set("directory", input.directory)
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return await fetchRuntimePath({
      directory: input.directory,
      path: `${url.pathname}${url.search}`,
      init: input.init,
    })
  }

  const listSessions = async (input: { directory: AgentRuntimeDirectory; roots?: boolean; limit?: number }) => {
    if (signed) {
      const target = await workspaceTarget(input.directory)
      // `target.workspace?.kind` is `workspaceTarget()`'s own derivation, which
      // only confirms a kind from an id already in hand (session ref, explicit
      // option, or a `ws_`/`workspace:` directory ref) or from the resolve
      // response's `kind` field. A user-hosted workspace addressed by its
      // filesystem-path directory can still resolve a `workspaceId` there
      // without a `kind` — the hosted control plane does not track kind for a
      // directory it does not itself own — so fall back to `options.workspaceKind`,
      // the caller-confirmed kind threaded down from the signed inventory (see
      // its declaration above). Without this, that case fell through to the
      // central sessions list, which holds nothing for user-hosted workspaces.
      if ((target.workspace?.kind ?? options.workspaceKind) === "user-hosted") {
        const url = sessionListUrl({
          serverUrl: serverUrl(),
          scope: input.directory,
          roots: input.roots,
          limit: input.limit,
        })
        const res = await fetchRuntimePath({
          directory: input.directory,
          path: `${url.pathname}${url.search}`,
          init: { headers: { Accept: "application/json" } },
        })
        return { sessions: await readJson<AgentPresentationSession[]>(res) }
      }
      const res = await request(
        controlSessionListUrl({
          baseUrl: agentRuntimeBaseUrl(serverUrl()),
          workspaceId: target.workspaceId,
        }),
        await signedControlPlaneInit(),
      )
      return { sessions: sessionRows(await readJson<unknown>(res)) }
    }
    const res = await fetchPath(input.directory, agentRuntimeSessionListUrl({
      serverUrl: serverUrl(),
      scope: input.directory,
      roots: input.roots,
      limit: input.limit,
    }))
    return { sessions: await readJson<AgentPresentationSession[]>(res) }
  }

  return {
    usesScopedTransport: usesScopedSessionTransport,
    listSessions,
    async createSession(input: AgentRuntimeSessionCreateInput) {
      const url = agentRuntimeSessionListUrl({ serverUrl: serverUrl(), scope: input.directory })
      const selection = harnessSelectionQuery(input.harness)
      if ("nativeHarness" in selection) url.searchParams.set("nativeHarness", selection.nativeHarness)
      else url.searchParams.set("connectionId", selection.connectionId)
      const res = await fetchRuntimePath({
        directory: input.directory,
        path: `${url.pathname}${url.search}`,
        init: jsonInit("POST", {
          agent: input.agent,
          model: input.model,
          ...(input.variant ? { variant: input.variant } : {}),
        }, { headers: input.headers }),
      })
      return { data: createdSession(await readJson<unknown>(res)) }
    },
    async deleteSession(input: { directory: AgentRuntimeDirectory; sessionID: string }) {
      const res = await fetchRuntimeSession({
        sessionID: input.sessionID,
        directory: input.directory,
        init: { method: "DELETE", headers: { Accept: "application/json" } },
      })
      return deleteResult(await readJson<unknown>(res))
    },
    async getSession(input: { directory: AgentRuntimeDirectory; sessionID: string }) {
      // A user-hosted workspace has NO central session store — the hosted
      // control plane's session-list endpoint is an empty stub, so the
      // signed list-emulation below can never find the row. Fall through to
      // `fetchSessionResource`, which diverts to the runtime via the relay.
      if (signed && options.workspaceKind !== "user-hosted") {
        const row = (await listSessions({ directory: input.directory })).sessions
          .find((item) => item.id === input.sessionID)
        if (!row) return { data: undefined }
        return { data: row }
      }
      const res = await fetchSessionResource({
        sessionID: input.sessionID,
        directory: input.directory,
        init: { headers: { Accept: "application/json" } },
      })
      return { data: await readJson<AgentPresentationSession>(res) }
    },
    async getSessionConfig(input: { directory: AgentRuntimeDirectory; sessionID: string; signal?: AbortSignal }) {
      const res = await fetchRuntimeSession({
        sessionID: input.sessionID,
        directory: input.directory,
        suffix: "/config",
        init: { headers: { Accept: "application/json" }, signal: input.signal },
      })
      return await readJson<unknown>(res)
    },
    async updateSessionConfig(input: { directory: AgentRuntimeDirectory; sessionID: string; patch: unknown }) {
      const res = await fetchRuntimeSession({
        sessionID: input.sessionID,
        directory: input.directory,
        suffix: "/config",
        init: jsonInit("PATCH", input.patch),
      })
      return await readJson<unknown>(res)
    },
    async getCapabilities(input: { directory: AgentRuntimeDirectory; sessionID?: string; harness?: string; signal?: AbortSignal }) {
      if (!input.sessionID && !input.harness) return DEFAULT_AGENT_RUNTIME_CAPABILITIES
      if (input.sessionID && !shouldUseRuntimeSessionTransport(input)) return DEFAULT_AGENT_RUNTIME_CAPABILITIES
      const res = input.sessionID
        ? await fetchRuntimeSession({
          sessionID: input.sessionID,
          directory: input.directory,
          suffix: "/capabilities",
          init: { headers: { Accept: "application/json" }, signal: input.signal },
        })
        : await fetchRuntimePath({
          directory: input.directory,
          path: `/session/capabilities?directory=${encodeURIComponent(input.directory)}&harness=${encodeURIComponent(input.harness!)}`,
          init: { headers: { Accept: "application/json" }, signal: input.signal },
        })
      return await readJson<SessionTransportCapabilities>(res)
    },
    ...createAgentRuntimeGoalClient(fetchRuntimeSession),
    async getMessages(input: {
      directory: AgentRuntimeDirectory
      sessionID: string
      signal?: AbortSignal
    } & SessionMessagePageRequest) {
      input.signal?.throwIfAborted()
      const res = await fetchSessionResource({
        sessionID: input.sessionID,
        directory: input.directory,
        resource: "messages",
        query: {
          limit: input.limit,
          before: input.before,
          view: input.view,
        },
        init: {
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: input.signal,
        },
      })
      input.signal?.throwIfAborted()
      const body = await readJson<unknown>(res)
      input.signal?.throwIfAborted()
      return {
        data: messageRows(body),
        response: res,
        maxEventOrdinal: ordinal(body, res),
      }
    },
    async getTodos(input: { directory: AgentRuntimeDirectory; sessionID: string }) {
      const res = await fetchRuntimeSession({
        sessionID: input.sessionID,
        directory: input.directory,
        suffix: "/todo",
        init: { headers: { Accept: "application/json" } },
      })
      return { data: await readJson<AgentTodo[]>(res) }
    },
    /**
     * Permission modes for a session, in the HARNESS's own vocabulary.
     */
    async getPermissionModes(input: { directory: AgentRuntimeDirectory; sessionID: string; harness?: string }) {
      const init: RequestInit = { cache: "no-store", headers: { Accept: "application/json" } }
      // A DRAFT has no session, so it asks the directory-scoped route instead of
      // showing nothing until after the first message. Same payload either way;
      // the difference is only which harness state can answer — a draft gets the
      // static list where one exists, and an ACP agent honestly reports none
      // until it has been asked.
      //
      // `harness` is REQUIRED on the draft path, not decoration. A draft has no
      // session for the route to resolve an adapter from, so without it the
      // runtime falls back to the directory's default harness and answers for
      // THAT one — while the picker labels the group with the harness the
      // composer actually targets. The visible symptom was a group headed
      // "Codex" reading "opencode has no permission modes of its own".
      const harnessQuery = input.harness ? `&harness=${encodeURIComponent(input.harness)}` : ""
      const res = input.sessionID
        ? await fetchRuntimeSession({
          sessionID: input.sessionID,
          directory: input.directory,
          suffix: "/permission-mode",
          ...(input.harness ? { query: { harness: input.harness } } : {}),
          init,
        })
        : await fetchRuntimePath({
          directory: input.directory,
          path: `/permission/modes?directory=${encodeURIComponent(input.directory)}${harnessQuery}`,
          init,
        })
      return { data: await readJson<AgentRuntimePermissionModeState>(res) }
    },
    async setPermissionMode(input: { directory: AgentRuntimeDirectory; sessionID: string; modeId: string }) {
      const res = await fetchRuntimeSession({
        sessionID: input.sessionID,
        directory: input.directory,
        suffix: "/permission-mode",
        init: jsonInit("PUT", { modeId: input.modeId }),
      })
      // Returns what the harness KEPT, which can differ from `input.modeId`.
      return { data: await readJson<AgentRuntimePermissionModeState>(res) }
    },
    async sendMessage(input: AgentRuntimePromptPayload & { mode?: "sync" | "async" }) {
      const res = await fetchRuntimeSession({
        sessionID: input.sessionID,
        directory: input.directory,
        suffix: input.mode === "sync" ? "/message" : "/prompt_async",
        init: jsonInit("POST", input),
      })
      if (input.mode !== "sync" && !res.ok) throw await runtimeRequestError(res)
      return input.mode === "sync"
        ? { data: await readJson<AgentPromptResponse>(res) }
        : { data: undefined }
    },
    async abort(input: { directory: AgentRuntimeDirectory; sessionID: string }) {
      const url = agentRuntimeSessionUrl({
        serverUrl: serverUrl(),
        sessionID: input.sessionID,
        suffix: "/abort",
      })
      url.searchParams.set("directory", input.directory)
      return await fetchRuntimePath({
        directory: input.directory,
        path: `${url.pathname}${url.search}`,
        init: { method: "POST" },
      })
    },
    async answerPermission(input: { directory: AgentRuntimeDirectory; sessionID: string; permissionID: string; response: "once" | "always" | "reject" }) {
      const url = agentRuntimeSessionUrl({
        serverUrl: serverUrl(),
        sessionID: input.sessionID,
        suffix: `/permissions/${encodeURIComponent(input.permissionID)}`,
      })
      url.searchParams.set("directory", input.directory)
      return await fetchRuntimePath({
        directory: input.directory,
        path: `${url.pathname}${url.search}`,
        init: jsonInit("POST", { response: input.response }),
      })
    },
    async answerQuestion(input: { directory: AgentRuntimeDirectory; sessionID?: string; questionID: string; answer: string }) {
      const url = new URL(`/question/${encodeURIComponent(input.questionID)}/reply`, agentRuntimeSessionUrl({
        serverUrl: serverUrl(),
        sessionID: input.sessionID ?? "runtime",
      }))
      url.searchParams.set("directory", input.directory)
      if (input.sessionID) url.searchParams.set("sessionId", input.sessionID)
      return await fetchRuntimePath({
        directory: input.directory,
        path: `${url.pathname}${url.search}`,
        init: jsonInit("POST", { answer: input.answer }),
      })
    },
    async rejectQuestion(input: { directory: AgentRuntimeDirectory; sessionID?: string; questionID: string }) {
      const url = new URL(`/question/${encodeURIComponent(input.questionID)}/reject`, agentRuntimeSessionUrl({
        serverUrl: serverUrl(),
        sessionID: input.sessionID ?? "runtime",
      }))
      url.searchParams.set("directory", input.directory)
      if (input.sessionID) url.searchParams.set("sessionId", input.sessionID)
      return await fetchRuntimePath({
        directory: input.directory,
        path: `${url.pathname}${url.search}`,
        init: { method: "POST" },
      })
    },
    subscribeToEvents(input: { serverUrl?: string; sessionID?: string; workspaceId?: string }) {
      if (!input.workspaceId) {
        return claxedoEventsUrl({
          serverUrl: input.serverUrl ?? serverUrl(),
          ...(input.sessionID ? { sessionID: input.sessionID } : {}),
        })
      }
      const url = new URL(`/workspaces/${encodeURIComponent(input.workspaceId)}/global/event`, input.serverUrl ?? serverUrl())
      if (input.sessionID) url.searchParams.set("sessionID", input.sessionID)
      return url
    },
    subscribeToRuntimeEvents(input: { serverUrl?: string; workspaceId?: string; directory?: string } = {}) {
      if (input.workspaceId) return new URL(`/workspaces/${encodeURIComponent(input.workspaceId)}/api/wr/runtime-events`, input.serverUrl ?? serverUrl())
      if (!input.directory) throw new Error("workspaceId or directory is required for runtime events")
      const url = new URL("/api/wr/runtime-events", input.serverUrl ?? serverUrl())
      url.searchParams.set("directory", input.directory)
      return url
    },
  }
}
