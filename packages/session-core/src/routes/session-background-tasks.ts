import { routeParam } from "@claxedo/helpers/route-param"
import { asString } from "@claxedo/helpers/guards"
import { errorBody } from "./error-body"
import { boundedJsonRecord, noStoreJson } from "./http"
import { unsupportedOperation } from "./session-harness-refusal"
import { sessionOperationGuard } from "./session-operation-guard"
import type { SessionRouteContext as Ctx, SessionRouteOptions as Opts } from "./session-route-options"

export function backgroundTaskStopRoute(opts: Opts) {
  return async (c: Ctx): Promise<Response> => {
    const sessionId = routeParam(c, "id")
    const guarded = await sessionOperationGuard(opts, c, sessionId, "background_task_stop")
    if (guarded) return guarded
    const toolCallId = asString((await boundedJsonRecord(c)).toolCallId)
    if (!toolCallId) return noStoreJson(c, errorBody("invalid_request", "A background task is named by its toolCallId"), 400)
    const directory = await opts.resolveDirectory(c, { sessionId })
    const stopped = await (await opts.runtime(c)).backgroundTasks.stop(sessionId, { toolCallId }, directory ?? undefined)
    if (stopped.ok) return noStoreJson(c, stopped)
    if (stopped.status === "not_found") return noStoreJson(c, stopped, 404)
    return unsupportedOperation(c, stopped.harness, "background_task_stop", { capability: "backgroundTasks" })
  }
}
