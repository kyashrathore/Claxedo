import { Hono, type Context } from "hono"
import { type SessionEnvFactory } from "@claxedo/agent-sdk-runtime"
import { createCentralSessionRuntime } from "./central-session-runtime"
import { ControlPlaneSessionRoutes } from "./control-plane/routes/control-plane-session"
import { isLoopbackLocalRequest } from "./routes/local-only-projection"
import {
  ControlPlaneAuthError,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  localOnlyAuthAdapter,
  type SignedControlPlaneAuth,
  type ClerkVerifier,
  type ControlPlaneAuthAdapter,
  type ControlPlaneAuthConfig,
} from "./control-plane/auth"
import type { ControlPlaneServices } from "./control-plane/services"
import { requireAuthority } from "./control-plane/authority"
import type { ConnectionTurnCredentials } from "./connections-host/turn-credentials"

export { createCentralSessionRuntime } from "./central-session-runtime"
export { ControlPlaneAuthError, localOnlyAuthAdapter, type ControlPlaneAuthAdapter } from "./control-plane/auth"
export { createControlPlaneServices } from "./control-plane/services"
export type { ControlPlaneServices } from "./control-plane/services"

export type CentralControlAppOptions = {
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
  createEnv?: SessionEnvFactory
  turnCredentials?: ConnectionTurnCredentials
}

function centralControlRequest(request: Request) {
  const url = new URL(request.url)
  url.pathname = url.pathname === "/api/control"
    ? "/"
    : url.pathname.slice("/api/control".length)
  return new Request(url, request)
}

function centralRuntimeSessionId(request: Request) {
  const pathname = new URL(request.url).pathname
  const prefix = "/api/control/session/"
  if (!pathname.startsWith(prefix)) return
  const raw = pathname.slice(prefix.length).split("/")[0]
  if (!raw) return
  try {
    return decodeURIComponent(raw)
  } catch {
    throw new ControlPlaneAuthError(400, "invalid_session_id", "Session id is malformed")
  }
}

async function authorizeSignedCentralRuntimeSession(
  services: ControlPlaneServices,
  auth: SignedControlPlaneAuth,
  sessionId: string,
) {
  const meta = await services.projectionStore.session_meta(sessionId)
  if (meta?.host !== "central") {
    throw new ControlPlaneAuthError(
      403,
      "central_session_required",
      "Signed central runtime access requires a central session",
    )
  }
  if (!meta?.workspaceID) {
    throw new ControlPlaneAuthError(
      403,
      "central_session_workspace_required",
      "Signed central session access requires workspace scope",
    )
  }
  await requireAuthority(services).authorizeSessionRead(auth, {
    sessionId,
    workspaceId: meta.workspaceID,
  })
}

async function centralRuntimeAccess(
  request: Request,
  services: ControlPlaneServices,
  options: CentralControlAppOptions,
) {
  if (isLoopbackLocalRequest(request)) return {}
  try {
    const auth = await controlPlaneAuthContext(request, {
      config: options.authConfig,
      verifier: options.verifier,
    })
    if (auth.mode !== "signed") {
      throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
    }
    const sessionId = centralRuntimeSessionId(request)
    if (!sessionId) {
      throw new ControlPlaneAuthError(
        403,
        "central_session_required",
        "Signed central runtime access requires a central session",
      )
    }
    await authorizeSignedCentralRuntimeSession(services, auth, sessionId)
    return { subject: auth.user.subject }
  } catch (err) {
    if (err instanceof ControlPlaneAuthError) {
      return Response.json(controlPlaneAuthErrorBody(err), { status: err.status })
    }
    throw err
  }
}

export function createCentralControlApp(services: ControlPlaneServices, options: CentralControlAppOptions = {}) {
  const runtime = createCentralSessionRuntime(services, {
    ...(options.createEnv ? { createEnv: options.createEnv } : {}),
    ...(options.turnCredentials ? { turnCredentials: options.turnCredentials } : {}),
  })
  const app = new Hono()
  app.route("/api/control", ControlPlaneSessionRoutes(services, {
    ...(options.authConfig ? { authConfig: options.authConfig } : {}),
    ...(options.verifier ? { verifier: options.verifier } : {}),
    createHybridSession: runtime.createHybridSession,
  }))
  const forwardRuntimeRequest = async (request: Request) => {
    const access = await centralRuntimeAccess(request, services, options)
    if (access instanceof Response) return access
    const sessionId = centralRuntimeSessionId(request)
    const message = request.method === "POST" && new URL(request.url).pathname.endsWith("/message")
    if (!message || !sessionId) return runtime.routes.fetch(centralControlRequest(request))
    return runtime.runTurn({ sessionId, ...(access.subject ? { subject: access.subject } : {}) }, () =>
      runtime.routes.fetch(centralControlRequest(request)),
    )
  }
  app.all("/api/control", async (c) => forwardRuntimeRequest(c.req.raw))
  app.all("/api/control/*", async (c) => forwardRuntimeRequest(c.req.raw))
  app.get("/api/wr/runtime-events", async (c: Context) => {
    const access = await centralRuntimeAccess(c.req.raw, services, options)
    if (access instanceof Response) return access
    return runtime.runtimeEvents(c as never)
  })
  return { app, runtime }
}
