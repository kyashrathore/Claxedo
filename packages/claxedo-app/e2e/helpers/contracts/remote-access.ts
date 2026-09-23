// CONTRACT BINDING: /api/claxedo/remote-access/*
//
// The browser product's machine remote-access port
// (src/platform/remote-access/http-machine-remote-access.ts) speaks to the
// routes `deployments/self-hosted-node/app.ts` mounts here. This binding runs
// those routes (`RemoteAccessRoutes`) over a caller-supplied service, so the
// wire is snake_case exactly where the server writes it, the status fields are
// forced false exactly when the server's availability rule says so, and an
// unsigned caller is refused with the server's own 401 body.
import type { Route } from "@playwright/test"
import { RemoteAccessRoutes, type RemoteAccessService } from "../../../../claxedo-server/src/routes/remote-access"
// The route's own specifier: it tells a refusal from a crash by `instanceof`,
// so a second copy of this module would turn every 401 into a 500.
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"

const MOUNT = "/api/claxedo/remote-access"

export type RemoteAccessDeployment = {
  /**
   * Whether the server authenticates signed callers. The self-hosted app
   * accepts only a signed control-plane context on these routes, so an
   * unsigned deployment answers every one of them 401.
   */
  signed: boolean
  /** `CLAXEDO_DEVICE_LOGIN_ISSUER` is set. */
  deviceLoginConfigured: boolean
  /** A relay URL and a host tunnel token signer are both configured. */
  relayConfigured: boolean
  service: RemoteAccessService
}

const E2E_SIGNED_AUTH: SignedControlPlaneAuth = {
  mode: "signed",
  user: { subject: "test-user", tokenIdentifier: "e2e|test-user", issuer: "e2e" },
}

/** An account that has enrolled no machine. */
export function emptyRemoteAccessService(): RemoteAccessService {
  return {
    status: async () => ({ enrolled: false, enabled: false, secondDeviceOpen: false }),
    enable: async () => {
      throw new Error("remote-access contract: enable reached a service with no machine to enroll")
    },
    devices: async () => [],
    revoke: async () => ({ revoked: false }),
    rename: async () => undefined,
    markSecondDeviceOpen: async () => ({ recorded: false }),
  }
}

/** Neither device sign-in nor a relay is configured: what the e2e server is. */
export function unconfiguredRemoteAccessDeployment(signed: boolean): RemoteAccessDeployment {
  return { signed, deviceLoginConfigured: false, relayConfigured: false, service: emptyRemoteAccessService() }
}

export function isRemoteAccessPath(pathname: string) {
  return pathname === MOUNT || pathname.startsWith(`${MOUNT}/`)
}

/** Answer a browser request with what the real routes return for it. */
export async function fulfillRemoteAccessRoute(route: Route, deployment: RemoteAccessDeployment) {
  const request = route.request()
  const incoming = new URL(request.url())
  const driven = new URL(incoming.pathname.slice(MOUNT.length) || "/", "http://remote-access.contract")
  driven.search = incoming.search
  const routes = RemoteAccessRoutes({
    deviceLoginConfigured: deployment.deviceLoginConfigured,
    relayConfigured: deployment.relayConfigured,
    authenticate: async () => {
      if (deployment.signed) return E2E_SIGNED_AUTH
      throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
    },
    service: deployment.service,
  })
  const method = request.method()
  const body = method === "GET" || method === "HEAD" ? undefined : request.postData() ?? undefined
  const response = await routes.request(driven, { method, headers: { "content-type": "application/json" }, body })
  return route.fulfill({
    status: response.status,
    contentType: "application/json",
    body: await response.text(),
  })
}
