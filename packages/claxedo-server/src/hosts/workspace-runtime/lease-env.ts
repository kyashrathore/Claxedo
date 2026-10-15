import { Hono } from "hono"
import type { WorkspaceRuntimeRouteContribution } from "@claxedo/workspace-runtime/route-contribution"
import { RUNTIME_LEASE_ENV_PATH } from "@claxedo/server-core/hosts/workspace-runtime/env"
import { asRecord } from "@claxedo/helpers/guards"
import { controlPlaneOnly } from "./control-plane-only"
import { configureRuntimeGitAuth } from "./git-auth"

const LEASE_ENV_KEYS = ["CLAXEDO_GITHUB_CLONE_AUTH", "CLAXEDO_GITHUB_CLONE_BROKER_URL"] as const

/**
 * Takes the lease env the control plane hands this runtime afresh while it
 * serves: the clone placeholder its git presents at the plane's broker. The
 * delivery replaces the boot's whole set, so a key it leaves out is withdrawn.
 */
export function runtimeLeaseEnv(bootEnv: NodeJS.ProcessEnv): WorkspaceRuntimeRouteContribution {
  return {
    id: "lease-env",
    mount: () => {
      const app = new Hono()
      app.use(RUNTIME_LEASE_ENV_PATH, controlPlaneOnly("Only the control plane delivers this runtime's lease env"))
      app.put(RUNTIME_LEASE_ENV_PATH, async (c) => {
        const body = asRecord(await c.req.json().catch(() => undefined))
        if (!body) return c.json({ error: { code: "invalid_lease_env", message: "A lease env is a JSON object" } }, 400)
        const delivered: NodeJS.ProcessEnv = { ...bootEnv }
        for (const key of LEASE_ENV_KEYS) {
          const value = body[key]
          if (value !== undefined && typeof value !== "string") {
            return c.json({ error: { code: "invalid_lease_env", message: `${key} must be a string` } }, 400)
          }
          delivered[key] = value
        }
        try {
          await configureRuntimeGitAuth(delivered)
        } catch (error) {
          return c.json({ error: { code: "lease_env_refused", message: error instanceof Error ? error.message : String(error) } }, 400)
        }
        return c.body(null, 204)
      })
      return { path: "/", routes: app, dispose: () => {} }
    },
  }
}
