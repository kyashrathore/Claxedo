import type { ContentfulStatusCode } from "hono/utils/http-status"

/**
 * A response status Hono will accept for `c.json(body, status)`.
 *
 * Error types that cross this package carry a plain `number` — `statusOf`,
 * `AgentMessagePageError.status`, a status read off a remote response — and
 * every route narrowed it with `as ContentfulStatusCode`, which admits `204`
 * and `304` too. Those are exactly the codes Hono forbids a body on, so the
 * assertion was hiding the one mistake it looked like it was preventing.
 */
const CONTENTFUL_STATUSES = [
  200, 201, 202, 400, 401, 402, 403, 404, 405, 406, 408, 409, 410, 412, 413, 415, 422, 423, 424,
  428, 429, 431, 451, 500, 501, 502, 503, 504, 507,
] as const satisfies readonly ContentfulStatusCode[]

export function contentfulStatus(value: number, fallback: ContentfulStatusCode = 500): ContentfulStatusCode {
  return CONTENTFUL_STATUSES.find((status) => status === value) ?? fallback
}
