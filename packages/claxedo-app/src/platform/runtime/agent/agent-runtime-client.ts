import type {
  Message,
  OutputFormat,
  Part,
  SessionPromptResponse,
  TextPartInput,
  FilePartInput,
  AgentPartInput,
  Todo,
} from "@opencode-ai/sdk/v2/client"
import { apiBearerToken, authFetch } from "@/platform/api/api"
import type { SessionTransportCapabilities } from "@/platform/runtime/capabilities"
import { supportsSessionDirectory, type SessionRef } from "@/platform/identity/session-ref"
import { usesScopedSessionTransport, workspaceIdFromRef } from "@/platform/identity/legacy-resolver"
import { queryClient } from "@/platform/query/query-client"
import { fastSessionSwitchAnyNetworkQuiet } from "@/platform/runtime/session-switch"
import type { RuntimeSession, SessionMessagePageRequest } from "@/platform/runtime/session"
import {
  controlSessionListUrl,
  workspaceResolveUrl,
} from "@/platform/runtime/agent/workspace-control-routes"
import { centralTransportForServer, createTransport } from "@/platform/runtime/transport"
import { workspaceKind } from "@/platform/runtime/agent/workspace-kind"
import {
  resolveRuntimePlacement,
  resolveSessionResourceRoute,
  shouldUseRuntimeSessionTransport as decideRuntimeSessionTransport,
} from "@/platform/runtime/agent/placement-table"
import { centralRuntimePath } from "./central-runtime-path"
import {
  agentRuntimeBaseUrl,
  agentRuntimeEventsUrl as claxedoEventsUrl,
  agentRuntimeSessionListUrl as sessionListUrl,
  agentRuntimeSessionResourceUrl as sessionResourceUrl,
  agentRuntimeSessionUrl as sessionUrl,
  normalizedAgentRuntimeServerUrl,
  type AgentRuntimeDirectory,
  type AgentRuntimeSessionResource,
} from "./agent-runtime-urls"
export { centralRuntimePath } from "./central-runtime-path"
export type { AgentRuntimeDirectory } from "./agent-runtime-urls"
/**
 * One permission mode as the harness describes it.
 *
 * Declared here rather than imported from `@claxedo/agent-sdk-runtime` because
 * this is a WIRE shape — what the route actually serialises — and the app must
 * keep parsing it even when the runtime package moves ahead of the client.
 * `packages/claxedo-app/src/features/session/permission/modes.test.ts` pins it
 * against the runtime's own declaration so the two cannot drift unnoticed.
 */
export type AgentRuntimePermissionMode = {
  id: string
  name: string
  description?: string
  level?: "ask" | "auto" | "full"
}

export type AgentRuntimePermissionModeState = {
  modes: AgentRuntimePermissionMode[]
  currentModeId?: string
  unsupported?: string
  appliesFrom: "next-turn" | "next-session"
}

export type AgentRuntimeMessageRow = {
  info: Message
  parts?: Part[]
}

export type AgentRuntimeMessagesPage = {
  data?: AgentRuntimeMessageRow[]
  maxEventOrdinal: number
  response: Response
}

/**
 * A workspace directory as the runtime transport addresses it.
 * Exported so callers can name the concept instead of writing a bare string
 * parameter. Directory-string-shape routing is this codebase's largest single
 * piece of debt, and the architecture ratchet counts every new raw string
 * directory parameter; naming the type is the direction out of that debt, not a
 * way around the count.
 * (Written without the raw declaration spelled out, because the ratchet matches
 * on text and would count this comment as another offender.)
 */
export type AgentRuntimePromptPayload = {
  sessionID: string
  directory: AgentRuntimeDirectory
  agent: string
  model: { providerID: string; modelID: string }
  messageID: string
  parts: Array<(TextPartInput | FilePartInput | AgentPartInput) & { id: string }>
  variant?: string
  system?: string
  format?: OutputFormat
  /**
   * The permission mode this turn should run under, applied by the runtime
   * BEFORE the prompt reaches the harness.
   *
   * On the prompt rather than a separate call because of the FIRST turn: the
   * session is created by this very message, so a mode chosen in the composer
   * beforehand has no session to be written to yet. Sending it here is the only
   * way a user's choice can govern the opening turn instead of arriving after
   * the agent has already acted.
   */
  permissionMode?: string
}

type ControlSessionRow = RuntimeSession & {
  session_id?: string
  project_id?: string
  created_at?: number
  updated_at?: number
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
}

export function agentRuntimeWorkspaceTargetQueryKey(input: { serverUrl?: string; directory: AgentRuntimeDirectory }) {
  return ["shell", "agent-runtime-workspace-target", normalizedAgentRuntimeServerUrl(input.serverUrl), input.directory] as const
}

async function readJson<T>(res: Response): Promise<T> {
  if (res.ok) return await res.json()
  throw new Error((await res.text()) || `Request failed: ${res.status}`)
}

function ordinal(data: unknown, response: Response) {
  if (data && typeof data === "object") {
    const value = (data as { maxEventOrdinal?: unknown }).maxEventOrdinal
    if (typeof value === "number") return value
  }
  return Number(response.headers.get("x-max-event-ordinal") ?? 0) || 0
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
  opencodeClient?: AgentRuntimeOpenCodeClient
} = {}) {
  const request = options.request ?? authFetch
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

  function shouldUseRuntimeSessionTransport(input: { sessionID?: string; directory: AgentRuntimeDirectory }) {
    return decideRuntimeSessionTransport({
      sessionID: input.sessionID,
      directory: input.directory,
      signed,
      sessionRef: options.sessionRef,
    })
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
    const directoryWorkspaceId = workspaceIdFromRef(input.directory)
    const runtimeUrl = sessionResourceUrl({
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
        return await request(sessionResourceUrl({
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
    return await runtimeTransport({
      directory: input.directory,
      sessionRef,
      workspaceId: target?.workspaceId,
      preferRelayOnLoopback: signed,
    }).fetch(centralRuntimePath(input.path, sessionRef), init)
  }

  async function fetchRuntimeSession(input: {
    sessionID: string
    directory: AgentRuntimeDirectory
    suffix?: string
    query?: Record<string, string | number | undefined>
    init?: RequestInit
  }) {
    const url = sessionUrl({
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
      if (target.workspace?.kind === "user-hosted") {
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
        return { sessions: await readJson<RuntimeSession[]>(res) }
      }
      const res = await request(
        controlSessionListUrl({
          baseUrl: agentRuntimeBaseUrl(serverUrl()),
          workspaceId: target.workspaceId,
        }),
        await signedControlPlaneInit(),
      )
      return await readJson<{ sessions?: RuntimeSession[] }>(res)
    }
    const res = await fetchPath(input.directory, sessionListUrl({
      serverUrl: serverUrl(),
      scope: input.directory,
      roots: input.roots,
      limit: input.limit,
    }))
    return { sessions: await readJson<RuntimeSession[]>(res) }
  }

  return {
    usesScopedTransport: usesScopedSessionTransport,
    listSessions,
    async createSession(input: { directory: AgentRuntimeDirectory; headers?: Record<string, string> }) {
      if (!shouldUseRuntimeSessionTransport(input) && options.opencodeClient?.session.create) {
        return await options.opencodeClient.session.create({ directory: input.directory }, input.headers ? { headers: input.headers } : undefined)
      }
      const url = sessionListUrl({ serverUrl: serverUrl(), scope: input.directory })
      const res = await fetchRuntimePath({
        directory: input.directory,
        path: `${url.pathname}${url.search}`,
        init: {
        method: "POST",
        headers: input.headers,
        },
      })
      return { data: await readJson<RuntimeSession>(res) }
    },
    async getSession(input: { directory: AgentRuntimeDirectory; sessionID: string }) {
      if (!shouldUseRuntimeSessionTransport(input) && options.opencodeClient?.session.get) {
        return await options.opencodeClient.session.get({ sessionID: input.sessionID })
      }
      // A user-hosted workspace has NO central session store — the hosted
      // control plane's session-list endpoint is an empty stub, so the
      // signed list-emulation below can never find the row. Fall through to
      // `fetchSessionResource`, which diverts to the runtime via the relay.
      if (signed && options.workspaceKind !== "user-hosted") {
        const row = ((await listSessions({ directory: input.directory })).sessions ?? [])
          .map((item) => item as ControlSessionRow)
          .find((item) => item.id === input.sessionID || item.session_id === input.sessionID)
        if (!row) return { data: undefined }
        const id = row.session_id ?? row.id ?? input.sessionID
        return {
          data: {
            ...row,
            id,
            slug: row.slug ?? id,
            projectID: row.projectID ?? row.project_id ?? "",
            title: row.title ?? "Session",
            directory: input.directory,
            version: row.version ?? "",
            time: {
              created: row.created_at ?? row.time?.created ?? 0,
              updated: row.updated_at ?? row.time?.updated ?? row.created_at ?? row.time?.created ?? 0,
            },
          },
        }
      }
      const res = await fetchSessionResource({
        sessionID: input.sessionID,
        directory: input.directory,
        init: { headers: { Accept: "application/json" } },
      })
      return { data: await readJson<RuntimeSession>(res) }
    },
    async getSessionConfig(input: { directory: AgentRuntimeDirectory; sessionID: string }) {
      const res = await fetchRuntimeSession({
        sessionID: input.sessionID,
        directory: input.directory,
        suffix: "/config",
        init: { headers: { Accept: "application/json" } },
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
    async getCapabilities(input: { directory: AgentRuntimeDirectory; sessionID?: string }) {
      if (!shouldUseRuntimeSessionTransport(input)) return DEFAULT_AGENT_RUNTIME_CAPABILITIES
      if (!input.sessionID) return DEFAULT_AGENT_RUNTIME_CAPABILITIES
      const res = await fetchRuntimeSession({
        sessionID: input.sessionID,
        directory: input.directory,
        suffix: "/capabilities",
        init: { headers: { Accept: "application/json" } },
      })
      return await readJson<SessionTransportCapabilities>(res)
    },
    async getMessages(input: {
      directory: AgentRuntimeDirectory
      sessionID: string
      signal?: AbortSignal
    } & SessionMessagePageRequest) {
      input.signal?.throwIfAborted()
      if (!shouldUseRuntimeSessionTransport(input) && options.opencodeClient?.session.messages) {
        const result = await options.opencodeClient.session.messages(input, { signal: input.signal })
        input.signal?.throwIfAborted()
        return {
          ...result,
          maxEventOrdinal: ordinal(result.data, result.response),
        }
      }
      if (!signed && options.workspaceId) {
        const projected = await fetchProjectedMessages(input).catch(() => undefined)
        input.signal?.throwIfAborted()
        if (projected) return projected
      }
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
      const body = await readJson<AgentRuntimeMessageRow[] | { messages?: AgentRuntimeMessageRow[]; maxEventOrdinal?: number }>(res)
      input.signal?.throwIfAborted()
      return {
        data: Array.isArray(body) ? body : body.messages ?? [],
        response: res,
        maxEventOrdinal: ordinal(body, res),
      }
    },
    async getTodos(input: { directory: AgentRuntimeDirectory; sessionID: string }) {
      if (!shouldUseRuntimeSessionTransport(input) && options.opencodeClient?.session.todo) {
        return await options.opencodeClient.session.todo({ sessionID: input.sessionID })
      }
      const res = await fetchRuntimeSession({
        sessionID: input.sessionID,
        directory: input.directory,
        suffix: "/todo",
        init: { headers: { Accept: "application/json" } },
      })
      return { data: await readJson<Todo[]>(res) }
    },
    /**
     * Permission modes for a session, in the HARNESS's own vocabulary.
     *
     * Runtime transport only, with no `opencodeClient` fallback — unlike the
     * neighbouring methods. The opencode engine has no mode list at all (it has
     * per-tool rules), so there is nothing on that client to fall back TO, and a
     * fallback that silently answered `[]` would make an unreachable route look
     * like a harness with nothing to offer.
     */
    async getPermissionModes(input: { directory: AgentRuntimeDirectory; sessionID: string; harness?: string }) {
      const init = { cache: "no-store" as const, headers: { Accept: "application/json" } }
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
      if (!shouldUseRuntimeSessionTransport(input) && options.opencodeClient?.session.prompt && options.opencodeClient.session.promptAsync) {
        if (input.mode === "sync") return await options.opencodeClient.session.prompt(input)
        return await options.opencodeClient.session.promptAsync(input)
      }
      const res = await fetchRuntimeSession({
        sessionID: input.sessionID,
        directory: input.directory,
        suffix: input.mode === "sync" ? "/message" : "/prompt_async",
        init: jsonInit("POST", input),
      })
      if (input.mode !== "sync" && !res.ok) throw new Error((await res.text()) || `Request failed: ${res.status}`)
      return input.mode === "sync" ? { data: await readJson<SessionPromptResponse>(res) } : { data: undefined }
    },
    async abort(input: { directory: AgentRuntimeDirectory; sessionID: string }) {
      if (!shouldUseRuntimeSessionTransport(input) && options.opencodeClient?.session.abort) {
        return await options.opencodeClient.session.abort({ sessionID: input.sessionID })
      }
      const url = sessionUrl({
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
      const url = sessionUrl({
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
      const url = new URL(`/question/${encodeURIComponent(input.questionID)}/reply`, sessionUrl({
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
      const url = new URL(`/question/${encodeURIComponent(input.questionID)}/reject`, sessionUrl({
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
      if (!input.workspaceId) return claxedoEventsUrl({ serverUrl: input.serverUrl ?? serverUrl() })
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

  async function fetchProjectedMessages(input: {
    directory: AgentRuntimeDirectory
    sessionID: string
    signal?: AbortSignal
  } & SessionMessagePageRequest): Promise<AgentRuntimeMessagesPage | undefined> {
    const url = sessionResourceUrl({
      serverUrl: serverUrl(),
      signedControlPlane: true,
      workspaceId: options.workspaceId,
      sessionID: input.sessionID,
      directory: input.directory,
      resource: "messages",
      query: {
        limit: input.limit,
        before: input.before,
        view: input.view,
      },
    })
    const res = await request(url, await controlPlaneAuthInit({
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: input.signal,
    }))
    input.signal?.throwIfAborted()
    if (!res.ok) return
    const body = await readJson<AgentRuntimeMessageRow[] | { messages?: AgentRuntimeMessageRow[]; maxEventOrdinal?: number }>(res)
    input.signal?.throwIfAborted()
    const data = Array.isArray(body) ? body : body.messages ?? []
    const maxEventOrdinal = ordinal(body, res)
    if (data.length === 0 && maxEventOrdinal === 0) return
    return { data, response: res, maxEventOrdinal }
  }
}
