import { responseError } from "./errors"
import type { Transport } from "./transport"
import type { FeatureAvailability } from "./types"

const PARAMETERS_MISSING = 400

export async function probeAvailability(transport: Transport, path: string): Promise<FeatureAvailability> {
  const response = await transport.request(path)
  if (response.ok || response.status === PARAMETERS_MISSING) return { kind: "available" }
  return { kind: "unavailable", reason: (await responseError(response, path)).message }
}
