import { errorBody as dispatchErrorBody, statusOf } from "@claxedo/server-core/platform/errors/base"
import { Hono, type Context } from "hono"
import { AGENT_HARNESS_IDS } from "@claxedo/agent-sdk-runtime"
import type { MachineSessionCreate } from "../machine-dispatch"
import { AgentMessagePageError, type AgentMessagePageInput } from "@claxedo/agent-sdk-runtime/message-page"
import type { ControlPlaneServices } from "../../authority/services"
import { resolveSessionGateway } from "../../authority/http"
import {
  ControlPlaneAuthError,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ControlPlaneTokenVerifier,
  type ControlPlaneAuthConfig,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import { isLoopbackLocalRequest } from "@claxedo/server-core/platform/http/peer-address"
import {
  buildSessionListResponse,
  parseSessionListQuery,
  sessionListStoreFilter,
  sessionListStorePageFilter,
  sessionInventoryResponse,
  requiredWorkspaceId,
  signedSessionList, sessionListErrorResponse } from "../list"
import { messagePageCursor, parseMessagePageInput } from "../message-page"
import type { SessionShareChangedSink } from "../session-people-contract"
import { SessionPeopleControlRoutes } from "./session-people-routes"
import { asRecord, readJsonRecord } from "@claxedo/server-core/platform/json/index"
import { contentfulStatus } from "../../platform/http/status"

type Options = {
  authConfig?: ControlPlaneAuthConfig
  verifier?: ControlPlaneTokenVerifier
  beforeLocalList?: () => Promise<void>
  createMachineSession?: (input: MachineSessionCreate, auth?: SignedControlPlaneAuth) => Promise<{ id: string }>
  sessionShareChangedSink?: SessionShareChangedSink
}

async function signedAuth(req: Request, options: Options) {
  const auth = await controlPlaneAuthContext(req, {
    config: options.authConfig,
    verifier: options.verifier,
  })
  if (auth?.mode === "signed") return auth
  throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
}


function hasBearerToken(req: Request) {
  return /^Bearer\s+\S+$/i.test(req.headers.get("authorization") ?? "")
}

function authorityMessages(body: unknown) {
  if (Array.isArray(body)) return body
  const messages = asRecord(body)?.messages
  return Array.isArray(messages) ? messages : []
}

function authorityReadAllowed(body: unknown) {
  return !(
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    (body as { allowed?: boolean }).allowed === false
  )
}

function messagePageJson(
  c: Context,
  body: unknown,
  messages: unknown[],
  maxEventOrdinal: number,
) {
  const cursor = messagePageCursor(body)
  if (cursor) {
    c.header("Access-Control-Expose-Headers", "X-Next-Cursor")
    c.header("X-Next-Cursor", cursor)
  }
  return c.json({
    ...(body && typeof body === "object" && !Array.isArray(body) ? body : {}),
    messages,
    maxEventOrdinal,
  })
}

function projectedMessagePage(
  services: ControlPlaneServices,
  sessionId: string,
  page: AgentMessagePageInput,
) {
  const read = services.projectionStore.read_session_message_page
  if (!read) throw new AgentMessagePageError(501, "message paging is unavailable for the session projection")
  return read(sessionId, page)
}

function workspaceTransportCapabilities(transport: string) {
  return {
    transport,
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

export function ControlPlaneSessionRoutes(services: ControlPlaneServices, options: Options = {}) {
  const app = new Hono()
  // The People routes are also mounted by hosted workerd. Keep the central
  // surface on that worker-safe owner rather than maintaining two copies.
  app.route("/", SessionPeopleControlRoutes(services, {
    authConfig: options.authConfig,
    verifier: options.verifier,
    ...(options.sessionShareChangedSink ? { sessionShareChangedSink: options.sessionShareChangedSink } : {}),
  }))
  return app
    .get("/session-list", async (c) => {
      try {
        const query = parseSessionListQuery(new URL(c.req.url))
        if (isLoopbackLocalRequest(c.req.raw) && !hasBearerToken(c.req.raw)) {
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
        return c.json(await signedSessionList(services, auth, query))
      } catch (err) {
        const mapped = sessionListErrorResponse(err)
        if (mapped) return mapped
        throw err
      }
    })
    .post("/sessions", async (c) => {
      try {
        const auth = isLoopbackLocalRequest(c.req.raw) && !hasBearerToken(c.req.raw) ? undefined : await signedAuth(c.req.raw, options)
        const body = await readJsonRecord(c.req.raw)
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["workspaceId", "title", "harness", "model"].includes(key))) throw new ControlPlaneAuthError(400, "invalid_session_request", "Use workspaceId, title, harness and model for machine sessions")
        if (typeof body.workspaceId !== "string" || !body.workspaceId.trim()) throw new ControlPlaneAuthError(400, "workspace_required", "Select a machine workspace first")
        if (typeof body.harness !== "string" || !AGENT_HARNESS_IDS.some((id) => id === body.harness)) throw new ControlPlaneAuthError(400, "harness_required", "Select a supported native harness")
        if (body.title !== undefined && typeof body.title !== "string") throw new ControlPlaneAuthError(400, "invalid_session_request", "title must be a string")
        let model: MachineSessionCreate["model"]
        if (body.model !== undefined) {
          const value = asRecord(body.model)
          if (!value || Object.keys(value).some(key => !["providerID", "modelID"].includes(key)) || typeof value.providerID !== "string" || !value.providerID.trim() || typeof value.modelID !== "string" || !value.modelID.trim()) throw new ControlPlaneAuthError(400, "invalid_session_request", "model requires providerID and modelID")
          model = { providerID: value.providerID, modelID: value.modelID }
        }
        if (!options.createMachineSession) throw new ControlPlaneAuthError(503, "machine_dispatch_unavailable", "Create this session through its workspace runtime")
        if (auth) await requireAuthority(services).authorizeWorkspaceOpen(auth, { workspaceId: body.workspaceId })
        const session = await options.createMachineSession({ workspaceId: body.workspaceId, ...(model ? { model } : {}), ...(typeof body.title === "string" ? { title: body.title } : {}), harness: { id: body.harness, access: "native" } }, auth)
        return c.json({ session }, 201)
      } catch (error) {
        if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
        if (statusOf(error) !== 500) return c.json(dispatchErrorBody(error), contentfulStatus(statusOf(error)))
        throw error
      }
    })
    .get("/sessions", async (c) => {
      try {
        // Local workspaces: the SQLite control-plane projection store is the
        // source of truth for the session inventory. On a loopback request we
        // serve it directly — optionally filtered by directory or workspaceId,
        // or the full local inventory when neither is given — with no remote
        // authority, no signed bearer token, and no dependence on an agent
        // runtime being queried.
        if (isLoopbackLocalRequest(c.req.raw) && !hasBearerToken(c.req.raw)) {
          const directory = c.req.query("directory")
          const workspaceId = c.req.query("workspaceId")
          return c.json(sessionInventoryResponse(
            await services.projectionStore.list_session_metas({
              ...(directory ? { directory } : {}),
              ...(workspaceId ? { workspaceID: workspaceId } : {}),
            }),
          ))
        }
        const auth = await signedAuth(c.req.raw, options)
        const workspaceId = requiredWorkspaceId(c.req.query("workspaceId"))
        return c.json(sessionInventoryResponse(
          await requireAuthority(services).listSessions(auth, { workspaceId }),
        ))
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
    .get("/sessions/:sessionId/gateway", async (c) => {
      try {
        if (isLoopbackLocalRequest(c.req.raw) && !hasBearerToken(c.req.raw)) {
          const meta = await services.projectionStore.session_meta(c.req.param("sessionId"))
          return c.json({
            gatewayUrl: null,
            workspaceId: meta?.workspaceID ?? null,
            directory: null,
            harnessHost: meta?.host ?? "workspace",
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
        const page = parseMessagePageInput(c.req.query("limit"), c.req.query("before"), c.req.query("view"))
        const maxEventOrdinal = services.projectionStore.read_session_max_event_ordinal(sessionId)
        if (isLoopbackLocalRequest(c.req.raw) && !hasBearerToken(c.req.raw)) {
          if (page) {
            const projected = projectedMessagePage(services, sessionId, page)
            return messagePageJson(c, projected, projected.messages, maxEventOrdinal)
          }
          const replayMessages = services.projectionStore.read_session_messages(sessionId)
          return c.json({
            messages: replayMessages,
            maxEventOrdinal,
          })
        }
        const auth = await signedAuth(c.req.raw, options)
        const workspaceId = requiredWorkspaceId(c.req.query("workspaceId"))
        const body = await requireAuthority(services).readSessionMessages(auth, {
          sessionId,
          workspaceId,
          ...page,
        })
        const messages = authorityMessages(body)
        if (page) return messagePageJson(c, body, messages, maxEventOrdinal)
        const replayMessages = services.projectionStore.read_session_messages(sessionId)
        const visibleMessages = authorityReadAllowed(body)
          ? (replayMessages.length > 0 ? replayMessages : messages)
          : []
        return c.json({
          ...(body && typeof body === "object" && !Array.isArray(body) ? body : {}),
          messages: visibleMessages,
          maxEventOrdinal: services.projectionStore.read_session_max_event_ordinal(sessionId),
        })
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        if (err instanceof AgentMessagePageError) {
          return c.json({ error: { code: "message_page_error", message: err.message } }, contentfulStatus(err.status))
        }
        throw err
      }
    })
    .get("/sessions/:sessionId/capabilities", async (c) => {
      try {
        const auth = await signedAuth(c.req.raw, options)
        const sessionId = c.req.param("sessionId")
        const meta = await services.projectionStore.session_meta(sessionId)
        await requireAuthority(services).authorizeSessionRead(auth, {
          sessionId,
          workspaceId: requiredWorkspaceId(c.req.query("workspaceId")),
        })
        const transport = meta?.tags.find((tag) => tag.startsWith("harness:"))?.slice("harness:".length)
        if (!transport) {
          return c.json(
            {
              error: {
                code: "session_harness_missing",
                message: "Session metadata does not contain a canonical harness binding",
              },
            },
            409,
          )
        }
        return c.json(workspaceTransportCapabilities(transport))
      } catch (err) {
        if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
        throw err
      }
    })
}
