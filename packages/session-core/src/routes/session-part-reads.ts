import { HTTPException } from "hono/http-exception"
import { routeParam } from "@claxedo/helpers/route-param"
import { errorBody, sessionNotFound } from "./error-body"
import { noStoreJson } from "./http"
import { sessionOperationGuard } from "./session-operation-guard"
import type { SessionRouteContext as Ctx, SessionRouteOptions as Opts } from "./session-route-options"
import { toolImageResponse } from "./tool-image"

export function messageAttachmentRoute(opts: Opts) {
  return async (c: Ctx): Promise<Response> => {
    const sessionId = routeParam(c, "id")
    const guarded = await sessionOperationGuard(opts, c, sessionId, "message_read")
    if (guarded) return guarded
    const directory = await opts.resolveDirectory(c, { sessionId })
    const messages = await opts.getMessages?.(c, directory, sessionId)
    if (!messages) return noStoreJson(c, sessionNotFound(), 404)
    return toolImageResponse({ readAttachment: opts.readAttachment, messages, sessionId, messageId: routeParam(c, "messageId"), attachmentId: routeParam(c, "attachmentId") })
  }
}

export function messagePartRoute(opts: Opts) {
  return async (c: Ctx): Promise<Response> => {
    const sessionId = routeParam(c, "id")
    const guarded = await sessionOperationGuard(opts, c, sessionId, "message_read")
    if (guarded) return guarded
    if (!opts.getPart) throw new HTTPException(501, { message: "part reads are not supported for this session" })
    const directory = await opts.resolveDirectory(c, { sessionId })
    const part = await opts.getPart(c, directory, sessionId, routeParam(c, "messageId"), routeParam(c, "partId"))
    if (!part) return noStoreJson(c, errorBody("part_not_found", "The session has no such part"), 404)
    return noStoreJson(c, part)
  }
}
