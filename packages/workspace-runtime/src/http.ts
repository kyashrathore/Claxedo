/**
 * HTTP primitives shared by Workspace Runtime routes and by host-supplied route
 * contributions.
 *
 * `route-contribution.ts` lets a host mount routes INTO the runtime, and those
 * routes have to parse bodies and shape errors the same way the runtime's own
 * routes do — a contribution whose error envelope differs from
 * `{ error: { code, message } }` produces responses that clients decode
 * differently depending on which handler answered.
 *
 * Publishing these is what lets a contribution package satisfy that contract
 * without vendoring a second copy of the bounded-body reader. The alternative
 * — copying `boundedJsonBody` into every contribution — duplicates the 5 MiB
 * request-size guard, which is a security bound, not a convenience.
 */
export {
  bearerToken,
  boundedJsonBody,
  errorBody,
  isRequestBodyTooLarge,
  requestBodyTooLargeBody,
  RequestBodyTooLargeError,
  JSON_BODY_LIMIT_BYTES,
} from "./routes/http"
