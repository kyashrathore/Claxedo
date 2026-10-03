import { Hono, type Context, type MiddlewareHandler } from "hono"
import {
  CustomProviderInvalidError,
  deleteCustomProvider,
  putCustomProvider,
  readCustomProvider,
} from "@claxedo/server-core/credentials/custom-provider"
import { opencodeProviderCatalog } from "@claxedo/server-core/credentials/opencode-provider-catalog"
import {
  ProviderCatalogViewError,
  projectProviderCatalog,
  readProviderCatalogView,
} from "@claxedo/server-core/credentials/provider-catalog-view"
import { CredentialDeliveryError } from "@claxedo/server-core/credentials/delivery"
import { customProviderEnvCredential } from "@claxedo/server-core/credentials/operations/sync"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { errorMessage } from "@claxedo/helpers"
import { workspaceProviderCatalog } from "../workspace-provider-catalog"
import { fanOutConfig } from "../fanout"
import type { AgentConfigRouteOptions } from "../route-options"
import { piProviderCatalog } from "@claxedo/server-core/credentials/pi-provider-catalog"
import { SINGLE_TENANT_ORG } from "@claxedo/server-core/credentials/partition"
import { ControlPlaneAuthError, controlPlaneAuthErrorBody, controlPlaneAuthConfig } from "@claxedo/server-core/platform/auth/auth"
import { requestActor, requestOrg } from "@claxedo/server-core/credentials/routes/credential"
import { providerAuthMethodsForHarness } from "@claxedo/server-core/credentials/provider-auth/service"
import { controlPlaneRouteAuth } from "@claxedo/server-core/platform/http/control-plane-route-auth"

const log = Log.create({ service: "agent-config-providers" })

const CATALOG_HARNESSES = new Set(["pi", "opencode"])

function unsupportedHarness(message: string) {
  return { error: { code: "provider_catalog_unsupported", message } } as const
}

export function agentConfigProviderRoutes(options: AgentConfigRouteOptions = {}) {
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
        const view = readProviderCatalogView({ provider: c.req.query("provider"), view: c.req.query("view") })
        if (c.req.query("nativeHarness") === "opencode") {
          const catalog = opencodeProviderCatalog({ engine: await workspaceProviderCatalog(c, authOptions, org), org, actor: await requestActor(c.req.raw, authOptions) })
          return c.json(projectProviderCatalog(catalog, view))
        }
        return c.json(projectProviderCatalog(piProviderCatalog(await requestActor(c.req.raw, authOptions), org), view))
      } catch (error) {
        if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
        if (error instanceof ProviderCatalogViewError) return c.json({ error: { code: error.code, message: error.message } }, error.status)
        throw error
      }
    })
    .get("/providers/auth", (c) => {
      const harness = c.req.query("nativeHarness")
      if (!harness || c.req.query("connectionId")) {
        return c.json(unsupportedHarness("Provider authentication requires a nativeHarness"), 400)
      }
      const methods = providerAuthMethodsForHarness(harness)
      if (!methods) return c.json(unsupportedHarness(`No sign-in methods are served for nativeHarness=${harness}`), 400)
      return c.json(methods)
    })
    .delete("/providers/custom/:providerId", requireCatalogHarness, async (c) => {
      if (c.req.query("nativeHarness") !== "opencode") return c.json(unsupportedHarness("Custom providers require OpenCode"), 400)
      try {
        deleteCustomProvider(c.req.param("providerId"), await requestOrg(c.req.raw, authOptions))
      } catch (error) {
        if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
        throw error
      }
      return await delivered(c, { ok: true })
    })
    /**
     * Declare an OpenAI-compatible provider for the caller's org.
     *
     * Configuration only. A typed API key is a credential and goes to
     * `/api/claxedo/credentials`; a body carrying secret material is rejected by
     * `readCustomProvider`'s allowlist rather than quietly persisted here. A
     * provider that names an environment variable instead has its key read by
     * the local credential collector and stored through the credential service.
     */
    .put("/providers/custom", requireCatalogHarness, async (c) => {
      if (c.req.query("nativeHarness") !== "opencode") {
        return c.json({ error: { code: "provider_custom_unsupported", message: "Custom providers require nativeHarness=opencode" } }, 400)
      }
      try {
        const org = await requestOrg(c.req.raw, authOptions)
        const body = await c.req.json().catch(() => undefined)
        // The unsigned single-tenant caller is the machine owner. A plaintext
        // loopback destination is theirs alone, and so is this server's
        // environment: a signed caller's env-sourced provider is stored, its
        // key is never read, and its sessions are refused at the transport.
        const machineOwner = org === SINGLE_TENANT_ORG && !authOptions.authConfig.enabled
        const config = readCustomProvider(body, { allowInsecureLoopback: machineOwner })
        const envCredential = machineOwner ? customProviderEnvCredential(config) : undefined
        if (machineOwner && config.env.length && !envCredential) {
          return c.json({ error: { code: "custom_provider_env_unset", message: `${config.env.join(", ")} is not set in this server's environment` } }, 400)
        }
        const provider = putCustomProvider(config, org)
        if (envCredential) {
          if (!options.services) throw new Error("An environment-sourced custom provider key needs the composed credential service")
          await options.services.credentials.putCredential({ owner: await requestActor(c.req.raw, authOptions),
            provider_id: envCredential.provider_id, kind: envCredential.kind, source: envCredential.source, label: envCredential.label,
            secret: envCredential.secret }, org)
        }
        return await delivered(c, provider)
      } catch (error) {
        if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
        if (error instanceof CustomProviderInvalidError) {
          return c.json({ error: { code: error.code, message: error.message } }, 400)
        }
        if (error instanceof CredentialDeliveryError) return deliveryFailure(c, error)
        throw error
      }
    })
}

async function delivered(c: Context, body: object) {
  try {
    await fanOutConfig()
  } catch (error) {
    return deliveryFailure(c, error)
  }
  return c.json(body)
}

function deliveryFailure(c: Context, error: unknown) {
  log.error("Custom provider stored; running workspaces did not take it", { error: errorMessage(error) })
  return c.json({ error: { code: "runtime_config_delivery_failed", message: "Stored, but running workspaces could not be updated" } }, 500)
}
