import { Hono } from "hono"
import { randomUUID } from "node:crypto"
import type { SandboxRef } from "@claxedo/agent-sdk-runtime"
import type { ControlPlaneServices } from "../services"
import type { SessionMeta } from "../../session/meta"
import { resolveSessionGateway } from "../http"
import {
  ControlPlaneAuthError,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
} from "../../platform/auth/auth"
import { requireAuthority } from "../../platform/auth/authority"
import { isLoopbackLocalRequest } from "../../routes/local-only-projection"
import {
  buildSessionListResponse,
  parseSessionListQuery,
  sessionListStoreFilter,
  sessionListStorePageFilter,
} from "../../session/list"

type Options = {
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
  beforeLocalList?: () => Promise<void>
  createHybridSession?: (input: { sessionId?: string; title?: string | null; workspaceId?: string | null; toolSandbox?: SandboxRef; harness?: string; model?: { providerID: string; modelID: string }; requireModel?: boolean }) => Promise<{ id: string }>
}

async function signedAuth(req: Request, options: Options) {
  const auth = await controlPlaneAuthContext(req, {
    config: options.authConfig,
    verifier: options.verifier,
  })
  if (auth?.mode === "signed") return auth
  throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
}

function requiredWorkspaceId(value: string | undefined) {
  if (value) return value
  throw new ControlPlaneAuthError(400, "workspace_id_required", "workspaceId is required")
}

function sessionListWorkspaceId(query: ReturnType<typeof parseSessionListQuery>) {
  return query.workspaceId ??
    (query.scope === "project" && query.projectId?.startsWith("ws_") ? query.projectId : undefined)
}

function hasBearerToken(req: Request) {
  return /^Bearer\s+\S+$/i.test(req.headers.get("authorization") ?? "")
}

function authorityMessages(body: unknown) {
  return Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { messages?: unknown }).messages)
      ? (body as { messages: unknown[] }).messages
      : []
}

function isSignedHostedBrowserRequest(req: Request) {
  return hasBearerToken(req) &&
    !!req.headers.get("origin") &&
    !!req.headers.get("x-opencode-directory")
}

async function authorizeCentralSessionRead(
  services: ControlPlaneServices,
  auth: Awaited<ReturnType<typeof signedAuth>>,
  sessionId: string,
  meta: SessionMeta,
) {
  const workspaceId = meta.workspaceID
  if (!workspaceId) {
    throw new ControlPlaneAuthError(
      403,
      "central_session_workspace_required",
      "Signed central session access requires workspace scope",
    )
  }
  await requireAuthority(services).authorizeSessionRead(auth, { sessionId, workspaceId })
}

function workspaceTransportCapabilities() {
  return {
    transport: "claude-acp",
    abort: true,
    reconnect: false,
    replay: true,
    permissions: false,
    questions: false,
    todos: false,
    commands: false,
    fork: true,
    revert: false,
    unrevert: false,
    configOptions: false,
  } as const
}

function centralTransportCapabilities() {
  return {
    transport: "pi",
    abort: true,
    reconnect: true,
    replay: true,
    permissions: false,
    questions: false,
    todos: false,
    commands: false,
    fork: false,
    revert: false,
    unrevert: false,
    configOptions: false,
  } as const
}

async function sessionCreateBody(req: Request) {
  try {
    const body = await req.json()
    return body && typeof body === "object" ? body as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function title(input: unknown) {
  return typeof input === "string" && input.trim().length > 0 ? input.trim() : undefined
}

function optionalText(input: unknown) {
  return typeof input === "string" && input.trim().length > 0 ? input.trim() : undefined
}

function toolSandboxRef(input: unknown): SandboxRef | undefined {
  if (input === undefined || input === null) return
  if (!input || typeof input !== "object") {
    throw new ControlPlaneAuthError(400, "invalid_tool_sandbox", "toolSandbox must be an object")
  }
  const item = input as Record<string, unknown>
  if (item.kind === "virtual") {
    return typeof item.id === "string" && item.id.length > 0 ? { kind: "virtual", id: item.id } : { kind: "virtual" }
  }
  if (item.kind === "workspace-runtime") {
    if (typeof item.workspaceId !== "string" || item.workspaceId.trim().length === 0) {
      throw new ControlPlaneAuthError(400, "invalid_tool_sandbox", "workspace-runtime toolSandbox requires workspaceId")
    }
    const directory = typeof item.directory === "string" && item.directory.trim().length > 0
      ? item.directory.trim()
      : undefined
    const worktree = optionalText(item.worktree)
    const baseCommit = optionalText(item.baseCommit) ?? optionalText(item.base_commit)
    const leaseEpoch = typeof item.leaseEpoch === "number" && Number.isInteger(item.leaseEpoch) && item.leaseEpoch >= 0
      ? item.leaseEpoch
      : undefined
    return {
      kind: "workspace-runtime",
      workspaceId: item.workspaceId.trim(),
      ...(directory ? { directory } : {}),
      ...(worktree ? { worktree } : {}),
      ...(baseCommit ? { baseCommit } : {}),
      ...(leaseEpoch !== undefined ? { leaseEpoch } : {}),
    }
  }
  throw new ControlPlaneAuthError(400, "invalid_tool_sandbox", "toolSandbox kind is unsupported")
}

function centralHybridToolSandbox(input: unknown): SandboxRef {
  return toolSandboxRef(input) ?? { kind: "virtual" as const }
}

function promptModel(input: unknown) {
  if (input === undefined || input === null) return
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ControlPlaneAuthError(400, "invalid_hybrid_model", "model must contain providerID and modelID")
  }
  const row = input as Record<string, unknown>
  const providerID = optionalText(row.providerID)
  const modelID = optionalText(row.modelID)
  if (!providerID || !modelID) {
    throw new ControlPlaneAuthError(400, "invalid_hybrid_model", "model must contain providerID and modelID")
  }
  return { providerID, modelID }
}

/**
 * Harnesses dispatchable on the central hybrid route today. `pi` is the
 * model-backed central harness; codex-acp/opencode sandbox harnesses join
 * when sandbox-session dispatch lands (W5/Demo C).
 */
const HYBRID_HARNESSES = new Set(["pi"])

function hybridHarness(input: unknown): string {
  if (input === undefined || input === null) return "pi"
  if (typeof input !== "string" || !HYBRID_HARNESSES.has(input)) {
    throw new ControlPlaneAuthError(
      400,
      "unsupported_hybrid_harness",
      `harness must be one of: ${[...HYBRID_HARNESSES].join(", ")}`,
    )
  }
  return input
}

export function ControlPlaneSessionRoutes(services: ControlPlaneServices, options: Options = {}) {
  return new Hono()
    .get("/session-list", async (c) => {
      try {
        const query = parseSessionListQuery(new URL(c.req.url))
        if (isLoopbackLocalRequest(c.req.raw) && !isSignedHostedBrowserRequest(c.req.raw)) {
          await options.beforeLocalList?.()
          const canUseBoundedProjection = query.groupBy === "none" &&
            query.environment.length === 0 &&
            query.git.length === 0 &&
            !!services.projectionStore.list_session_navigation_metas
          if (canUseBoundedProjection && services.projectionStore.list_session_navigation_metas) {
            return c.json(buildSessionListResponse({
              query,
              sessions: await services.projectionStore.list_session_navigation_metas(sessionListStorePageFilter(query)),
              cursorApplied: true,
            }))
          }
          return c.json(buildSessionListResponse({
            query,
            sessions: await services.projectionStore.list_session_metas(sessionListStoreFilter(query)),
          }))
        }
        const auth = await signedAuth(c.req.raw, options)
        const workspaceId = requiredWorkspaceId(sessionListWorkspaceId(query))
        const sessions = await requireAuthority(services).listSessions(auth, { workspaceId })
        return c.json(buildSessionListResponse({
          query: {
            ...query,
            scope: query.scope === "global" || (query.scope === "project" && query.projectId === workspaceId) ? "workspace" : query.scope,
            workspaceId,
          },
          sessions: Array.isArray(sessions) ? sessions : [],
        }))
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        if (err instanceof Error && err.message === "invalid_session_list_cursor") {
          return c.json({
            error: {
              code: "invalid_session_list_cursor",
              message: "Session list cursor does not match this query",
            },
          }, 400)
        }
        throw err
      }
    })
    .post("/sessions", async (c) => {
      try {
        if (!isLoopbackLocalRequest(c.req.raw)) {
          await signedAuth(c.req.raw, options)
          throw new ControlPlaneAuthError(400, "hybrid_loopback_only", "Hybrid session creation is only available on loopback")
        }
        const body = await sessionCreateBody(c.req.raw)
        if (body.mode !== "hybrid") {
          throw new ControlPlaneAuthError(400, "hybrid_mode_required", "Only mode=hybrid is supported by this route")
        }
        const sessionTitle = title(body.title) ?? "Hybrid Session"
        const toolSandbox = centralHybridToolSandbox(body.toolSandbox)
        const workspaceId = optionalText(body.workspaceId)
        const harness = hybridHarness(body.harness)
        const model = promptModel(body.model)
        const sessionId = optionalText(body.sessionId) ?? optionalText(body.session_id)
        const session = options.createHybridSession
          ? await options.createHybridSession({
              ...(sessionId ? { sessionId } : {}),
              title: sessionTitle,
              ...(workspaceId ? { workspaceId } : {}),
              toolSandbox,
              harness,
              requireModel: true,
              ...(model ? { model } : {}),
            })
          : { id: randomUUID() }
        if (!options.createHybridSession) {
          await services.projectionStore.put_session_meta(session.id, {
            host: "central",
            ...(workspaceId ? { workspaceID: workspaceId } : {}),
            directory: null,
            title: sessionTitle,
            ...(model ? { model } : {}),
          })
        }
        return c.json({
          session: {
            id: session.id,
            title: sessionTitle,
            host: "central",
            workspaceId: workspaceId ?? null,
          },
          placement: {
            sessionId: session.id,
            mode: "hybrid",
            host: "central",
            workspaceId: workspaceId ?? null,
            toolSandbox,
          },
        }, 201)
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
    .get("/sessions", async (c) => {
      try {
        // Local workspaces: the SQLite control-plane projection store is the
        // source of truth for the session inventory. On a loopback request we
        // serve it directly — optionally filtered by directory or workspaceId,
        // or the full local inventory when neither is given — with no remote
        // authority, no signed bearer token, and no dependence on the opencode
        // server being queried.
        if (isLoopbackLocalRequest(c.req.raw) && !isSignedHostedBrowserRequest(c.req.raw)) {
          const directory = c.req.query("directory")
          const workspaceId = c.req.query("workspaceId")
          return c.json({
            sessions: await services.projectionStore.list_session_metas({
              ...(directory ? { directory } : {}),
              ...(workspaceId ? { workspaceID: workspaceId } : {}),
            }),
          })
        }
        const auth = await signedAuth(c.req.raw, options)
        const workspaceId = requiredWorkspaceId(c.req.query("workspaceId"))
        return c.json({
          sessions: await requireAuthority(services).listSessions(auth, { workspaceId }),
        })
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
    .get("/sessions/:sessionId/gateway", async (c) => {
      try {
        if (isLoopbackLocalRequest(c.req.raw) && !isSignedHostedBrowserRequest(c.req.raw)) {
          const meta = await services.projectionStore.session_meta(c.req.param("sessionId"))
          return c.json({
            gatewayUrl: null,
            workspaceId: meta?.workspaceID ?? null,
            directory: null,
            harnessHost: meta?.host ?? "central",
          })
        }
        const auth = await signedAuth(c.req.raw, options)
        return c.json(await resolveSessionGateway(services, c.req.param("sessionId"), auth))
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
    .get("/sessions/:sessionId/messages", async (c) => {
      try {
        const sessionId = c.req.param("sessionId")
        if (isLoopbackLocalRequest(c.req.raw) && !isSignedHostedBrowserRequest(c.req.raw)) {
          const replayMessages = services.projectionStore.read_session_messages(sessionId)
          const maxEventOrdinal = services.projectionStore.read_session_max_event_ordinal(sessionId)
          const workspaceId = c.req.query("workspaceId")
          if (replayMessages.length === 0 && workspaceId && hasBearerToken(c.req.raw)) {
            const auth = await signedAuth(c.req.raw, options)
            const body = await requireAuthority(services).readSessionMessages(auth, { sessionId, workspaceId })
            return c.json({
              ...(body && typeof body === "object" && !Array.isArray(body) ? body : {}),
              messages: authorityMessages(body),
              maxEventOrdinal,
            })
          }
          return c.json({
            messages: replayMessages,
            maxEventOrdinal,
          })
        }
        const auth = await signedAuth(c.req.raw, options)
        const meta = await services.projectionStore.session_meta(sessionId)
        if (meta?.host === "central") {
          await authorizeCentralSessionRead(services, auth, sessionId, meta)
          return c.json({
            messages: services.projectionStore.read_session_messages(sessionId),
            maxEventOrdinal: services.projectionStore.read_session_max_event_ordinal(sessionId),
          })
        }
        const workspaceId = requiredWorkspaceId(c.req.query("workspaceId"))
        const body = await requireAuthority(services).readSessionMessages(auth, { sessionId, workspaceId })
        const messages = authorityMessages(body)
        const replayMessages = services.projectionStore.read_session_messages(sessionId)
        return c.json({
          ...(body && typeof body === "object" && !Array.isArray(body) ? body : {}),
          messages: replayMessages.length > 0 ? replayMessages : messages,
          maxEventOrdinal: services.projectionStore.read_session_max_event_ordinal(sessionId),
        })
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
    .get("/sessions/:sessionId/capabilities", async (c) => {
      try {
        const auth = await signedAuth(c.req.raw, options)
        const sessionId = c.req.param("sessionId")
        const meta = await services.projectionStore.session_meta(sessionId)
        if (meta?.host === "central") {
          await authorizeCentralSessionRead(services, auth, sessionId, meta)
          return c.json(centralTransportCapabilities())
        }
        await requireAuthority(services).authorizeSessionRead(auth, {
          sessionId,
          workspaceId: requiredWorkspaceId(c.req.query("workspaceId")),
        })
        return c.json(workspaceTransportCapabilities())
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
}
