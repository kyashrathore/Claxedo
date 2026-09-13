import { Hono, type MiddlewareHandler } from "hono"
import { HARNESS_TABLE, isHarnessId } from "@claxedo/agent-runtime-contract"
import {
  CustomProviderInvalidError,
  putCustomProvider,
  readCustomProvider,
} from "@claxedo/server-core/credentials/custom-provider"
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

function unsupportedHarness(message: string) {
  return { error: { code: "provider_catalog_unsupported", message } } as const
}

export function agentConfigProviderRoutes(options: ControlPlaneRouteAuthOptions = {}) {
  const authOptions = { ...options, authConfig: options.authConfig ?? controlPlaneAuthConfig() }
  const requireCatalogHarness: MiddlewareHandler = async (c, next) => {
    const harness = c.req.query("nativeHarness")
    if (!harness || !CATALOG_HARNESSES.has(harness) || c.req.query("connectionId")) {
      return c.json(unsupportedHarness("Provider catalog requires nativeHarness=pi or nativeHarness=opencode"), 400)
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
          return c.json(await opencodeProviderCatalog({ env, org }))
        }
        return c.json(piProviderCatalog(env, org))
      } catch (error) {
        if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
        throw error
      }
    })
    .get("/providers/auth", (c) => {
      const harness = c.req.query("nativeHarness")
      if (!harness || c.req.query("connectionId")) {
        return c.json(unsupportedHarness("Provider authentication requires a nativeHarness"), 400)
      }
      const methods = providerAuthMethods()
      if (CATALOG_HARNESSES.has(harness)) return c.json(methods)
      // A native harness runs on one vendor's account and has no catalog to
      // pick from, so `/providers` refuses it while this answers with the
      // sign-in methods of the provider its login is stored against — the only
      // way a caller learns the method index `provider.oauth.authorize` takes.
      const providerId = isHarnessId(harness) ? HARNESS_TABLE[harness].connectProvider : undefined
      const served = providerId === undefined ? undefined : methods[providerId]
      if (providerId === undefined || served === undefined) {
        return c.json(unsupportedHarness(`No sign-in methods are served for nativeHarness=${harness}`), 400)
      }
      return c.json({ [providerId]: served })
    })
    /**
     * Declare an OpenAI-compatible provider for the caller's org.
     *
     * Configuration only. The API key is a credential and goes to
     * `/api/claxedo/credentials`; a body carrying secret material is rejected by
     * `readCustomProvider`'s allowlist rather than quietly persisted here.
     */
    .put("/providers/custom", requireCatalogHarness, async (c) => {
      if (c.req.query("nativeHarness") !== "opencode") {
        return c.json({ error: { code: "provider_custom_unsupported", message: "Custom providers require nativeHarness=opencode" } }, 400)
      }
      try {
        const org = await requestOrg(c.req.raw, authOptions)
        const body = await c.req.json().catch(() => undefined)
        return c.json(putCustomProvider(readCustomProvider(body), org))
      } catch (error) {
        if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
        if (error instanceof CustomProviderInvalidError) {
          return c.json({ error: { code: error.code, message: error.message } }, 400)
        }
        throw error
      }
    })
}
