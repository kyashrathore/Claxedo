import { PreviewModelInvalidError } from "../host/config-ops"
import { routeParam } from "@claxedo/helpers/route-param"
import { errorBody } from "./error-body"
import { noStoreJson } from "./http"
import { harnessUnavailableResponse } from "./session-harness-refusal"
import { sessionOperationGuard } from "./session-operation-guard"
import { sessionConfigOf, sessionTarget, type SessionRouteContext, type SessionRouteOptions } from "./session-route-options"

export async function sessionConfigOptionsRead(opts: SessionRouteOptions, c: SessionRouteContext) {
  const sessionId = routeParam(c, "id")
  const guarded = await sessionOperationGuard(opts, c, sessionId, "session_config_read")
  if (guarded) return guarded
  const directory = await opts.resolveDirectory(c, { sessionId })
  const runtime = await opts.runtime(c)
  let preview: Awaited<ReturnType<typeof runtime.reads.configOptions>>
  try {
    preview = await runtime.reads.configOptions(sessionTarget(c, sessionId, directory), c.req.query("model") || undefined)
  } catch (cause) {
    if (cause instanceof PreviewModelInvalidError) return noStoreJson(c, errorBody("preview_model_invalid", cause.message), 400)
    const refusal = harnessUnavailableResponse(c, cause)
    if (refusal) return refusal
    throw cause
  }
  if (!preview) return noStoreJson(c, { error: "Session harness does not expose config options" }, 404)
  return noStoreJson(c, preview)
}

export async function sessionConfigRead(opts: SessionRouteOptions, c: SessionRouteContext) {
  const sessionId = routeParam(c, "id")
  const guarded = await sessionOperationGuard(opts, c, sessionId, "session_config_read")
  if (guarded) return guarded
  const directory = await opts.resolveDirectory(c, { sessionId })
  return noStoreJson(c, await sessionConfigOf(opts, c, directory, sessionId))
}
