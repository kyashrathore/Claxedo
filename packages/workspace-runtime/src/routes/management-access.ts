import type { WorkspaceRuntimeManagementAction, WorkspaceRuntimeManagementAuth, WorkspaceRuntimeManagementTarget } from "../management-auth"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"

export type ManagementAccessOptions = {
  managementAuth?: WorkspaceRuntimeManagementAuth
  managementTarget?: WorkspaceRuntimeManagementTarget
}

type ManagementContext = {
  req: { raw: Request; path: string; method: string }
  get(name: "relayHostAuth"): RelayHostAuthContext["relayHostAuth"] | undefined
  get(name: "relayHostDirectAuth"): RelayHostAuthContext["relayHostDirectAuth"] | undefined
}

type ManagementVerdict = { ok: true } | { ok: false; code: string; message: string; status: 401 | 403 }

/** One fail-closed boundary for the runtime's supervisor management operations. */
export async function authorizeManagementAccess(
  context: ManagementContext,
  options: ManagementAccessOptions,
  action: WorkspaceRuntimeManagementAction,
): Promise<ManagementVerdict> {
  const kind = action === "runtime.config.apply" ? "config" : "checkpoint"
  if (!options.managementAuth || !options.managementTarget) {
    return { ok: false, code: `runtime_${kind}_auth_required`, message: `Runtime ${kind} management auth is required`, status: 401 }
  }
  try {
    const result = await options.managementAuth.authorize({
      request: context.req.raw,
      action,
      target: options.managementTarget,
      path: context.req.path,
      method: context.req.method,
      relayAuth: context.get("relayHostAuth") ?? context.get("relayHostDirectAuth"),
    })
    if (result.ok && typeof result.subject === "string" && Array.isArray(result.scopes) && result.scopes.every((item) => typeof item === "string")) {
      return { ok: true }
    }
    if (!result.ok && (result.status === 401 || result.status === 403) && typeof result.code === "string" && typeof result.message === "string") {
      return { ok: false, status: result.status, code: result.code, message: result.message }
    }
  } catch {}
  return { ok: false, code: `runtime_${kind}_auth_failed`, message: `Runtime ${kind} management auth failed`, status: 401 }
}
