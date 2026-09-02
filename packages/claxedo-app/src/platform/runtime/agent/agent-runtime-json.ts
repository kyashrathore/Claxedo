/**
 * Shared JSON decoding for the workspace-runtime HTTP clients.
 *
 * Non-2xx is a TRANSPORT failure here: the body is surfaced as the error text so
 * callers report what the runtime actually said. Routes that answer with a typed
 * failure body under a non-2xx status (goal mutations) must decode it themselves
 * before falling back to this helper.
 */
export async function readRuntimeJson<T>(response: Response): Promise<T> {
  if (response.ok) return await response.json()
  throw new Error((await response.text()) || `Request failed: ${response.status}`)
}
