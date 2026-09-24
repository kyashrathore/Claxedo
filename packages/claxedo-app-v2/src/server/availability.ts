import { responseError } from "./errors"
import type { Transport } from "./transport"
import type { FeatureAvailability } from "./types"

export async function probeAvailability(transport: Transport, path: string): Promise<FeatureAvailability> {
  const response = await transport.request(path)
  if (response.ok) return { kind: "available" }
  return { kind: "unavailable", reason: (await responseError(response, path)).message }
}
