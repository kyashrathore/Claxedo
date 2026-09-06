import { Hono, type MiddlewareHandler } from "hono"
import { opencodeProviderCatalog } from "@claxedo/server-core/credentials/opencode-provider-catalog"
import { piProviderCatalog } from "@claxedo/server-core/credentials/pi-provider-catalog"
import { SINGLE_TENANT_ORG } from "@claxedo/server-core/credentials/provider-credential.sql"
import { ControlPlaneAuthError, controlPlaneAuthErrorBody, controlPlaneAuthConfig } from "@claxedo/server-core/platform/auth/auth"
import { requestOrg } from "../../credentials/routes/credential"
import { providerAuthMethods } from "../../credentials/provider-auth/service"
import { controlPlaneRouteAuth, type ControlPlaneRouteAuthOptions } from "../../platform/http/control-plane-route-auth"

/**
 * The harnesses whose provider/model catalog Claxedo owns and serves here.
 *
 * Pi's catalog is Claxedo's offline registry. OpenCode's is models.dev — the
 * catalog the engine itself reads — so the embedded-SDK harness can serve the
 * same picker without exposing a raw engine control route.
 */
const CATALOG_HARNESSES = new Set(["pi", "opencode"])

export function agentConfigProviderRoutes(options: ControlPlaneRouteAuthOptions = {}) {
  const authOptions = { ...options, authConfig: options.authConfig ?? controlPlaneAuthConfig() }
  const requireCatalogHarness: MiddlewareHandler = async (c, next) => {
    const harness = c.req.query("nativeHarness")
    if (!harness || !CATALOG_HARNESSES.has(harness) || c.req.query("connectionId")) {
      return c.json({ error: { code: "provider_catalog_unsupported", message: "Provider catalog requires nativeHarness=pi or nativeHarness=opencode" } }, 400)
    }
    await next()
    return undefined
  }
  return new Hono()
    .use("/providers", controlPlaneRouteAuth(authOptions))
    .use("/providers/*", controlPlaneRouteAuth(authOptions))
    .get("/providers", requireCatalogHarness, async (c) => {
      try {
        const org = await requestOrg(c.req.raw, authOptions)
        // Signed callers see only their credential partition, never the host's local OAuth or environment.
        const env = org === SINGLE_TENANT_ORG && !authOptions.authConfig.enabled ? process.env : {}
        if (c.req.query("nativeHarness") === "opencode") {
          // An unavailable catalog is a different fact from "no providers", so
          // it surfaces as a failure rather than an empty picker.
          return c.json(await opencodeProviderCatalog({ env }))
        }
        return c.json(piProviderCatalog(env, org))
      } catch (error) {
        if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
        throw error
      }
    })
    .get("/providers/auth", requireCatalogHarness, (c) => c.json(providerAuthMethods()))
}
