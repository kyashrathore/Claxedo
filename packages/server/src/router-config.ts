import type { FindMyWay } from "effect/unstable/http"

/**
 * `find-my-way` silently refuses to match a path parameter longer than
 * `maxParamLength`, which defaults to 100. The refusal is a bare router-level
 * 404 — no `Content-Type`, no body — issued before any handler runs, so it is
 * indistinguishable at a glance from a genuinely absent resource.
 *
 * Session ids are not bounded at 100 characters. A caller may derive a session
 * id from a composite run id that itself embeds an owner id, an operation id,
 * and a work-item id (~250 characters). Such a session could be created via
 * `POST /api/session` — the id arrives in the body — and listed, but every
 * route that addressed it through `:sessionID` 404'd, which read as "the
 * session vanished" rather than "the router rejected the id".
 *
 * The ceiling is a defense against adversarial URLs, not a schema constraint,
 * so raise it well past any id we generate rather than trimming ids to fit.
 */
export const ROUTER_CONFIG: Partial<FindMyWay.RouterConfig> = {
  maxParamLength: 1024,
}
