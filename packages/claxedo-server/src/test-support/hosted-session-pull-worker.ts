import type { D1Database } from "@cloudflare/workers-types"
import { localOnlyAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import { createD1CoreAuthority } from "../authority/adapters/d1/core-authority"
import { createIdempotencyCoordinator, d1ProjectionCommandIdempotency } from "../authority/http/idempotency"
import { UNUSED_DURABLE_SESSION_LOG, UNUSED_PROJECTION_STORE } from "../authority/unavailable-session-stores"
import type { ControlPlaneServices } from "../authority/services"
import { HostedControlRoutes } from "../routes/hosted/control"
import { authoritySessionReads, createSessionReadRoutes } from "../session/routes/session-read"
import { storedD1Session } from "./d1-stored-session"

async function compose(database: D1Database) {
  const { auth } = await storedD1Session(database)
  const authority = createD1CoreAuthority(database, { deploymentId: "test", product: { kind: "claxedo-hosted" } })
  const services = {
    authority,
    projectionStore: UNUSED_PROJECTION_STORE,
    durableSessionLog: UNUSED_DURABLE_SESSION_LOG,
    auth: localOnlyAuthAdapter(),
    credentials: {},
    relay: { provider: {
      mintRuntimeAccessToken: async () => ({ token: "test-runtime-token" }),
      getRelayEndpoint: async () => "https://runtime.test",
    } },
    sandbox: { sandboxManager: { target: async () => ({ status: "ready", hostId: "host", homeRegion: "us-east" }) } },
    telemetry: { capture: () => {} },
    localExecution: { enabled: false },
  } as unknown as ControlPlaneServices
  const routes = HostedControlRoutes(services, {
    authConfig: { enabled: true, issuer: auth.user.issuer, jwksUrl: "https://auth.test/jwks" },
    verifier: async () => auth,
    idempotency: createIdempotencyCoordinator(d1ProjectionCommandIdempotency(database)),
  })
  const reads = createSessionReadRoutes({ authenticate: async () => auth, reads: authoritySessionReads(authority) })
  return { auth, authority, routes, reads }
}

let composition: ReturnType<typeof compose> | undefined
export default {
  async fetch(request: Request, env: { CONTROL_PLANE_DB: D1Database }) {
    const { routes, reads, auth, authority } = await (composition ??= compose(env.CONTROL_PLANE_DB))
    if (new URL(request.url).pathname === "/stored") {
      return Response.json({
        session: await authority.resolveSession(auth, { sessionId: "ses" }),
        snapshot: await (await reads.request("/sessions/ses/messages?workspaceId=ws")).json(),
      })
    }
    return routes.fetch(request)
  },
}
