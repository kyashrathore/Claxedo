import { IMMUTABLE_SESSION_CONFIG_FIELDS, normalizeSessionConfigUpdate, type ImmutableSessionConfigField } from "../session-config"
import { routeParam } from "@claxedo/helpers/route-param"
import { errorBody } from "./error-body"
import { boundedJsonRecord } from "./http"
import { harnessUnavailableResponse, sessionConfigRefusalResponse } from "./session-harness-refusal"
import { sessionOperationGuard } from "./session-operation-guard"
import { requestSecretAuthority, type SessionRouteContext, type SessionRouteOptions } from "./session-route-options"

const IMMUTABLE_CONFIG_REFUSALS = {
  instructions: {
    code: "session_instructions_immutable",
    message: "A session's instructions are fixed at create and cannot be changed",
  },
  group: {
    code: "session_group_immutable",
    message: "A session's model group is fixed at create and cannot be changed",
  },
} as const satisfies Record<ImmutableSessionConfigField, { code: string; message: string }>

export async function sessionConfigWrite(opts: SessionRouteOptions, c: SessionRouteContext) {
  const sessionId = routeParam(c, "id")
  const guarded = await sessionOperationGuard(opts, c, sessionId, "session_config_write")
  if (guarded) return guarded
  const directory = await opts.resolveDirectory(c, { sessionId })
  const wire = await boundedJsonRecord(c)
  const immutable = IMMUTABLE_SESSION_CONFIG_FIELDS.find((field) => field in wire)
  if (immutable) {
    const refusal = IMMUTABLE_CONFIG_REFUSALS[immutable]
    return c.json(errorBody(refusal.code, refusal.message), 409)
  }
  const body = normalizeSessionConfigUpdate(wire)
  const requestedHarness = opts.requestedSessionHarness(c)
  if (requestedHarness) body.harness = requestedHarness
  try {
    return c.json(await (await opts.runtime(c)).sessions.updateConfig(sessionId, body, directory, requestSecretAuthority(c).secretAuthority))
  } catch (error) {
    const refusal = harnessUnavailableResponse(c, error) ?? sessionConfigRefusalResponse(c, error)
    if (refusal) return refusal
    throw error
  }
}
