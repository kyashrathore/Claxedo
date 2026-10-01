import { randomBytes } from "node:crypto"
import { startWorkerdRelay } from "../../../harness/e2e/harness/workerd-relay"

export type Relay = Awaited<ReturnType<typeof startWorkerdRelay>>
export type RelayInput = Parameters<typeof startWorkerdRelay>[0]

export function relayResolverToken() {
  return randomBytes(24).toString("hex")
}

export const startRelay = startWorkerdRelay
