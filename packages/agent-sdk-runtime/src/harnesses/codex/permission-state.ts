import { isDeepStrictEqual } from "node:util"
import type { JsonRecord, SdkRuntimeDriverHost } from "../shared/sdk-runtime-driver"

type CommandGrant = { directory: string; mode: string | null; request: JsonRecord }

// These fields describe the callback or its display, not the requested authority.
// Retain every other field, including unknown future permission context.
const callbackFields = new Set(["threadId", "turnId", "itemId", "approvalId", "startedAtMs", "reason", "commandActions"])

export function codexCommandGrant(method: string, params: JsonRecord, directory: string, mode: string | undefined): CommandGrant | undefined {
  if (method !== "item/commandExecution/requestApproval") return undefined
  if (typeof params.command !== "string" || !params.command || typeof params.cwd !== "string" || !params.cwd || !directory) return undefined
  return { directory, mode: mode ?? null, request: Object.fromEntries(Object.entries(params).filter(([key]) => !callbackFields.has(key))) }
}

export function hasCodexCommandGrant(host: SdkRuntimeDriverHost, sessionId: string, grant: CommandGrant) {
  const grants = host.getSessionConfig(sessionId)?.permissionState?.codexCommandGrants
  return Array.isArray(grants) && grants.some((saved) => isDeepStrictEqual(saved, grant))
}

export function saveCodexCommandGrant(host: SdkRuntimeDriverHost, sessionId: string, grant: CommandGrant) {
  if (hasCodexCommandGrant(host, sessionId, grant)) return
  const state = host.getSessionConfig(sessionId)?.permissionState ?? {}
  const grants = Array.isArray(state.codexCommandGrants) ? state.codexCommandGrants : []
  host.updatePermissionState(sessionId, { ...state, codexCommandGrants: [...grants, grant] })
}
