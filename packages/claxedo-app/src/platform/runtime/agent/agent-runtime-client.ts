import type { AgentContentPart, AgentPresentationMessage, AgentPresentationSession, AgentSession, AgentTodo, PromptDelivery, PromptModel } from "@claxedo/agent-runtime-contract"
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
import { errorMessage } from "@/lib/server-errors"

function appendHarnessSelection(query: URLSearchParams, selection: HarnessSelection | undefined) {
  if (selection) Object.entries(harnessSelectionQuery(selection)).forEach(([key, value]) => query.set(key, value))
}

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

/** A prompt the runtime is holding behind a running turn, as `GET /session/:id/queue` reports it. */
export type QueuedMessageRecord = {
  seq: number
  messageId?: string
  queuedAt: number
  parts: Array<{ type: string; text?: string; filename?: string }>
  /** Kept back from the next idle while a client edits it. */
  held: boolean
}

export type AgentRuntimeSessionCreateInput = {
  id?: string
  directory: AgentRuntimeDirectory
  harness: HarnessSelection
  agent: string
  model: PromptModel
  variant?: string
  headers?: Record<string, string>
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
  // `HeadersInit` is a Headers, a `[name, value][]`, or a record. Merging it as
  // an object literal only handled the record: an array form spread in as
  // numeric indices and the caller's headers were silently dropped. `Headers`
  // normalizes all three, and the caller still wins over the default type.
  const headers = new Headers({ "Content-Type": "application/json" })
  for (const [name, value] of new Headers(init?.headers)) headers.set(name, value)
  return {
    ...init,
    method,
    headers,
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
    if (!supportsSessionDirectory({ directory: input.directory, sessionRef: options.sessionRef })) throw new Error("A machine workspace directory is required")
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
      span.end({ ok: false, error: errorMessage(error) })
      throw error
    }
    async function sessionResourceResponse() {
    switch (route.via) {
      case "runtime-session-ref":
        return await runtimeTransport({
          directory: input.directory,
          sessionRef: options.sessionRef,
        }).fetch(runtimePath, init)
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
      default: {
        const unrouted: never = route
        throw new Error(`no runtime transport for route ${JSON.stringify(unrouted)}`)
      }
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
    if (!supportsSessionDirectory({ directory: input.directory, sessionRef: options.sessionRef })) throw new Error("A machine workspace directory is required")
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
      ...(target?.workspace?.kind ? { workspaceKind: target.workspace.kind } : {}),
    })
    try {
      const response = await runtimeTransport({
        directory: input.directory,
        sessionRef,
        workspaceId: target?.workspaceId,
        preferRelayOnLoopback: signed,
      }).fetch(input.path, init)
      span.end({ status: response.status, ok: response.ok, url: requestName(response.url || input.path) })
      return response
    } catch (error) {
      span.end({ ok: false, error: errorMessage(error) })
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
        const url = agentRuntimeSessionListUrl({
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
      appendHarnessSelection(url.searchParams, input.harness)
      const res = await fetchRuntimePath({
        directory: input.directory,
        path: `${url.pathname}${url.search}`,
        init: jsonInit("POST", {
          ...(input.id ? { id: input.id } : {}),
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
    async getCapabilities(input: { directory: AgentRuntimeDirectory; sessionID?: string; harness?: HarnessSelection; signal?: AbortSignal }) {
      const query = new URLSearchParams({ directory: input.directory })
      const selection = input.harness
      appendHarnessSelection(query, selection)
      const res = input.sessionID
        ? await fetchRuntimeSession({
          sessionID: input.sessionID,
          directory: input.directory,
          suffix: "/capabilities",
          init: { headers: { Accept: "application/json" }, signal: input.signal },
        })
        : await fetchRuntimePath({
          directory: input.directory,
          path: `/session/capabilities?${query}`,
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
    async getPermissionModes(input: { directory: AgentRuntimeDirectory; sessionID: string; harness?: HarnessSelection }) {
      const init: RequestInit = { cache: "no-store", headers: { Accept: "application/json" } }
      // Existing sessions own their binding; drafts must name an explicit
      // native harness or opaque connection before querying available modes.
      const selection = input.harness ?? options.sessionRef?.harness
      if (!input.sessionID && !selection) throw new Error("Draft permission modes require a harness selection")
      const query = new URLSearchParams({ directory: input.directory })
      appendHarnessSelection(query, selection)
      const res = input.sessionID
        ? await fetchRuntimeSession({
          sessionID: input.sessionID,
          directory: input.directory,
          suffix: "/permission-mode",
          init,
        })
        : await fetchRuntimePath({
          directory: input.directory,
          path: `/permission/modes?${query}`,
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
    async queuedMessages(input: { directory: AgentRuntimeDirectory; sessionID: string }) {
      const res = await fetchRuntimeSession({ ...input, suffix: "/queue" })
      if (!res.ok) throw await runtimeRequestError(res)
      return await readJson<QueuedMessageRecord[]>(res)
    },
    async controlQueuedMessage(input: { directory: AgentRuntimeDirectory; sessionID: string; seq: number; action: "cancel" | "steer" | "hold" | "release" }) {
      const res = await fetchRuntimeSession({ ...input, suffix: `/queue/${input.seq}/${input.action}`, init: { method: "POST" } })
      if (!res.ok) throw await runtimeRequestError(res)
    },
    /** Swaps a waiting message's parts; 409 once the runtime has admitted or dropped it. */
    async replaceQueuedMessage(input: { directory: AgentRuntimeDirectory; sessionID: string; seq: number; parts: AgentRuntimePromptPayload["parts"] }) {
      const res = await fetchRuntimeSession({ ...input, suffix: `/queue/${input.seq}/replace`, init: jsonInit("POST", { parts: input.parts }) })
      if (!res.ok) throw await runtimeRequestError(res)
    },
    async sendMessage(input: AgentRuntimePromptPayload) {
      const res = await fetchRuntimeSession({
        sessionID: input.sessionID,
        directory: input.directory,
        suffix: "/prompt_async",
        init: jsonInit("POST", input),
      })
      if (!res.ok) throw await runtimeRequestError(res)
      // Only a prompt that asked how a busy session should take it is answered
      // with a body; every other admission stays `204 No Content`.
      if (res.status === 204) return { data: undefined }
      return { data: await readJson<{ delivery?: PromptDelivery }>(res) }
    },
    async abort(input: { directory: AgentRuntimeDirectory; sessionID: string; turnId?: string }) {
      const url = agentRuntimeSessionUrl({
        serverUrl: serverUrl(),
        sessionID: input.sessionID,
        suffix: "/abort",
      })
      url.searchParams.set("directory", input.directory)
      // Names the turn the caller was looking at, so a request that lands after
      // that turn ended cannot cancel the one that replaced it.
      if (input.turnId) url.searchParams.set("turnId", input.turnId)
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
    async answerQuestion(input: { directory: AgentRuntimeDirectory; sessionID?: string; questionID: string; answers: string[][] }) {
      const url = new URL(`/question/${encodeURIComponent(input.questionID)}/reply`, agentRuntimeSessionUrl({
        serverUrl: serverUrl(),
        sessionID: input.sessionID ?? "runtime",
      }))
      url.searchParams.set("directory", input.directory)
      if (input.sessionID) url.searchParams.set("sessionId", input.sessionID)
      return await fetchRuntimePath({
        directory: input.directory,
        path: `${url.pathname}${url.search}`,
        init: jsonInit("POST", { answers: input.answers }),
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
  }
}
