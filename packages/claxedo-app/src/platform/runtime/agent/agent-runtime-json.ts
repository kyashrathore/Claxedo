import { runtimeRequestError } from "./agent-runtime-request-error"

/** Decode runtime responses without losing their status and structured error code. */
export async function readRuntimeJson<T>(response: Response): Promise<T> {
  if (response.ok) return await response.json()
  throw await runtimeRequestError(response)
}
