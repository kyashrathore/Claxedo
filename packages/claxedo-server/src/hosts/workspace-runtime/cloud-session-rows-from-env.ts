import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { workspaceId } from "@claxedo/workspace-runtime/host"
import { cloudSessionRowsGrant } from "./cloud-session-rows-grant"
import { cloudSessionRows } from "./cloud-session-rows"

export function cloudSessionRowsFromEnv(env: NodeJS.ProcessEnv) {
  const token = env.WORKSPACE_RUNTIME_SESSION_ROWS_TOKEN?.trim()
  const url = env.WORKSPACE_RUNTIME_SESSION_ROWS_URL?.trim()
  const renewUrl = env.WORKSPACE_RUNTIME_SESSION_ROWS_RENEW_URL?.trim()
  const expiresAt = Number(env.WORKSPACE_RUNTIME_SESSION_ROWS_EXPIRES_AT)
  if (!token && !url && !renewUrl && env.WORKSPACE_RUNTIME_SESSION_ROWS_EXPIRES_AT === undefined) return undefined
  if (!token || !url || !renewUrl || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    throw new Error("Cloud session rows require their workspace producer proof and publication endpoints")
  }
  const log = Log.create({ service: "claxedo-cloud-session-rows" })
  const warn = (message: string, details: Record<string, unknown>) => log.warn(message, details)
  const grant = cloudSessionRowsGrant({ token, expiresAt, renewUrl, warn })
  return cloudSessionRows({ workspaceId: workspaceId(env), url, grant, warn })
}
