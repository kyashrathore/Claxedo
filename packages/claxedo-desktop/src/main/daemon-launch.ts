import type { retire, verifyCreationIdentity } from "@claxedo/process-ownership/launch"

import { recoverPublishedDaemon, type DaemonOwnershipView, type DaemonRecoveryResult } from "./daemon-recovery"
import { createDaemonFetch } from "./daemon-request"
import { verifyClaxedoDaemonDiscovery, type ClaxedoDaemonDiscovery } from "./server-daemon-discovery"
import { daemonLeaseCount } from "./server-daemon-lease"

export type PublishedDaemonVerdict =
  | { kind: "adopt"; url: string; discovery: ClaxedoDaemonDiscovery }
  | { kind: "replace" }
  | { kind: "held"; message: string; unresolved?: { discovery: ClaxedoDaemonDiscovery; result: DaemonRecoveryResult } }

/**
 * What a launcher of `build` does with the daemon record found in `file`.
 *
 * A live daemon of this build is adopted, and so is a live daemon of another
 * build that another app still holds a lease on (development worktrees share
 * one daemon): its work is that app's, and its protocol answered as this
 * one's. A live daemon of another build that no app holds was left by one
 * that ended without quitting; adopting it would keep the old build serving
 * this app, so it is stopped and replaced, and its turns surface as
 * interrupted. A daemon that is not answering is never stopped from
 * launch: it may be busy or wedged, or its pid may now belong to another
 * process. A record this build cannot read is held the same way.
 */
export async function publishedDaemonVerdict(input: {
  published: ClaxedoDaemonDiscovery | "unreadable"
  file: string
  build: string
  snapshot: () => DaemonOwnershipView | undefined
  request?: typeof fetch
  verify?: typeof verifyCreationIdentity
  retireLaunch?: typeof retire
}): Promise<PublishedDaemonVerdict> {
  const discovery = input.published
  if (discovery === "unreadable") {
    return {
      kind: "held",
      message: `${input.file} records a Claxedo daemon this build cannot read, which may still be using this data directory. `
        + "Stop that process yourself and remove the file, then start Claxedo again.",
    }
  }
  const url = await verifyClaxedoDaemonDiscovery(discovery, input.request)
  if (url && discovery.build === input.build) return { kind: "adopt", url, discovery }
  if (url) {
    const daemon = createDaemonFetch({ endpoint: () => ({ origin: url, capability: discovery.token }), ...(input.request ? { fetch: input.request } : {}) })
    if ((await daemonLeaseCount(daemon)) !== 0) return { kind: "adopt", url, discovery }
  }
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
    unresolved: { discovery, result },
    message: url
      ? `The Claxedo daemon published as pid ${discovery.pid} was started by Claxedo ${discovery.build}, not this ${input.build}, `
        + "and stopping it did not complete. Stop that process yourself, then start Claxedo again."
      : `The Claxedo daemon published as pid ${discovery.pid} on port ${discovery.port} is not answering and stopping it `
        + "has not been authorized. Use the recovery view, or stop that process yourself.",
  }
}
