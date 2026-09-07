/**
 * The `{ error: { code, message } }` envelope every runtime route and every
 * host route contribution answers with.
 *
 * It sits apart from `./http` because that module reads
 * `WORKSPACE_RUNTIME_JSON_BODY_LIMIT_BYTES` at module scope through
 * `node:os`/`node:path`, and `session-access-policy.ts` — which the browser
 * `client.ts` bundle re-exports — needs the envelope without those.
 */
export function errorBody(code: string, message: string, details?: Record<string, unknown>) {
  return {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  }
}
