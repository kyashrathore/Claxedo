import { platformCallPermissions, type PluginCaller, type PluginPlatformAnswer, type PluginPlatformCall, type PluginPlatformRefusal } from "@claxedo/plugin-api/backend"
import { pluginPlatformCallSchema } from "@claxedo/plugin-api/backend-schema"
import type { PluginBackendActivation } from "./host-port"

export function refusedCall(status: number, code: string, message: string): PluginPlatformRefusal {
  return { ok: false, status, code, message }
}

export function answeredCall(value?: unknown): PluginPlatformAnswer {
  return value === undefined ? { ok: true } : { ok: true, value }
}

/** A call that acts as a person: it reads or grants in the caller's name, so a link or a wake cannot make it. */
function actsAsPerson(call: PluginPlatformCall): boolean {
  switch (call.name) {
    case "projects.list":
    case "projects.authorize":
    case "links.create":
    case "sessions.harnesses":
    case "sessions.preview":
    case "sessions.start":
    case "sessions.handoff":
    case "sessions.abandon":
    case "sessions.authorizeOpen":
      return true
    case "events.publish":
      return call.audience !== "org"
    default:
      return false
  }
}

export type AdmittedCall = Readonly<{ ok: true; call: PluginPlatformCall; caller: PluginCaller | undefined }>

/**
 * Admits a call a loaded backend made, in this order: its epoch is the
 * current activation (409 `plugin_backend_replaced`), its fields parse (400
 * `plugin_call_invalid`), the manifest declares its permissions (403
 * `plugin_permission_not_declared`), and a call that needs a caller has a
 * live handle (401 `plugin_caller_invalid`) for a person (403
 * `plugin_caller_not_a_person`).
 */
export function admitPlatformCall(input: {
  raw: unknown
  epoch: number
  activation: PluginBackendActivation | undefined
  caller: PluginCaller | undefined
}): AdmittedCall | PluginPlatformRefusal {
  const { activation } = input
  if (!activation || activation.epoch !== input.epoch) return refusedCall(409, "plugin_backend_replaced", "This backend is no longer the plugin's current activation")
  const parsed = pluginPlatformCallSchema.safeParse(input.raw)
  if (!parsed.success) {
    return refusedCall(400, "plugin_call_invalid", parsed.error.issues.map((issue) => `${issue.path.join(".") || "call"}: ${issue.message}`).join("; "))
  }
  const call = parsed.data
  const declared = activation.manifest.permissions ?? []
  const missing = platformCallPermissions(call).find((permission) => !declared.includes(permission))
  if (missing) {
    return refusedCall(403, "plugin_permission_not_declared", `${call.name} needs the ${missing} permission, which the manifest does not declare`)
  }
  if ((call.name === "identity.caller" || actsAsPerson(call)) && !input.caller) {
    return refusedCall(401, "plugin_caller_invalid", `${call.name} needs the live caller handle of the request or wake it serves`)
  }
  if (actsAsPerson(call) && !input.caller?.userId) {
    return refusedCall(403, "plugin_caller_not_a_person", `${call.name} acts as a person, and this caller is a ${input.caller?.origin ?? "nobody"}`)
  }
  return { ok: true, call, caller: input.caller }
}
