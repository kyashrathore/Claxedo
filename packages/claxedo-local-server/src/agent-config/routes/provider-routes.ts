import { Hono, type MiddlewareHandler } from "hono"
import { piProviderCatalog } from "@claxedo/server-core/credentials/pi-provider-catalog"
import { SINGLE_TENANT_ORG } from "@claxedo/server-core/credentials/provider-credential.sql"
import { ControlPlaneAuthError, controlPlaneAuthErrorBody, controlPlaneAuthConfig } from "@claxedo/server-core/platform/auth/auth"
import { requestOrg } from "../../credentials/routes/credential"
import { providerAuthMethods } from "../../credentials/provider-auth/service"
import { controlPlaneRouteAuth, type ControlPlaneRouteAuthOptions } from "../../platform/http/control-plane-route-auth"

export function agentConfigProviderRoutes(options: ControlPlaneRouteAuthOptions = {}) {
  const authOptions = { ...options, authConfig: options.authConfig ?? controlPlaneAuthConfig() }
  const requirePi: MiddlewareHandler = async (c, next) => {
    if (c.req.query("nativeHarness") !== "pi" || c.req.query("connectionId")) {
      return c.json({ error: { code: "provider_catalog_unsupported", message: "Provider catalog requires nativeHarness=pi" } }, 400)
    }
    await next()
  }
  return new Hono()
    .use("/providers", controlPlaneRouteAuth(authOptions))
    .use("/providers/*", controlPlaneRouteAuth(authOptions))
    .get("/providers", requirePi, async (c) => {
      try {
        const org = await requestOrg(c.req.raw, authOptions)
        // Signed callers see only their credential partition, never the host's local OAuth or environment.
        const env = org === SINGLE_TENANT_ORG && !authOptions.authConfig.enabled ? process.env : {}
        return c.json(piProviderCatalog(env, org))
      } catch (error) {
        if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
        throw error
      }
    })
    .get("/providers/auth", requirePi, (c) => c.json(providerAuthMethods()))
}
