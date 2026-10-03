import type { retire, verifyCreationIdentity } from "@claxedo/process-ownership/launch"

import { recoverPublishedDaemon, type DaemonOwnershipView, type DaemonRecoveryResult } from "./daemon-recovery"
import { verifyClaxedoDaemonDiscovery, type ClaxedoDaemonDiscovery } from "./server-daemon-discovery"

export type PublishedDaemonVerdict =
  | { kind: "adopt"; url: string }
  | { kind: "replace" }
  | { kind: "held"; result: DaemonRecoveryResult; message: string }

/**
 * What a launcher of `build` does with the daemon this machine published.
 *
 * A live daemon of this build is adopted. A live daemon of another build is
 * one a previous app left behind (a quit stops its daemon, so only a crash
 * leaves one); adopting it would keep the old build serving this app, so it is
 * stopped and replaced, and its turns surface as interrupted. A daemon that is
 * not answering is never stopped from launch: it may be busy or wedged, or its
 * pid may now belong to another process.
 */
export async function publishedDaemonVerdict(input: {
  discovery: ClaxedoDaemonDiscovery
  build: string
  snapshot: () => DaemonOwnershipView | undefined
  request?: typeof fetch
  verify?: typeof verifyCreationIdentity
  retireLaunch?: typeof retire
}): Promise<PublishedDaemonVerdict> {
  const { discovery } = input
  const url = await verifyClaxedoDaemonDiscovery(discovery, input.request)
  if (url && discovery.build === input.build) return { kind: "adopt", url }
  const result = await recoverPublishedDaemon({
    discovery,
    snapshot: input.snapshot(),
    authorize: () => url !== undefined,
    ...(input.verify ? { verify: input.verify } : {}),
    ...(input.retireLaunch ? { retireLaunch: input.retireLaunch } : {}),
  })
  if (result.replacementAllowed) return { kind: "replace" }
  return {
    kind: "held",
    result,
    message: url
      ? `The Claxedo daemon published as pid ${discovery.pid} was started by Claxedo ${discovery.build}, not this ${input.build}, `
        + "and stopping it did not complete. Stop that process yourself, then start Claxedo again."
      : `The Claxedo daemon published as pid ${discovery.pid} on port ${discovery.port} is not answering and stopping it `
        + "has not been authorized. Use the recovery view, or stop that process yourself.",
  }
}
