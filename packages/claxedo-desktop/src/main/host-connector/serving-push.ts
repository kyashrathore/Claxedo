/**
 * Hands one heartbeat ack's serving facts to the daemon.
 *
 * The daemon owns the workspace runtimes and therefore the relay connection,
 * so the credential the control plane mints for this machine has to cross from
 * the process that receives it (main, through the connector child) to the
 * process that dials with it. The addresses ride along because the daemon
 * admits a relayed caller against them: the relay's published key set verifies
 * the caller's Relay Host Token, and the session authority decides what that
 * caller may read. A push carrying the credential alone opens a tunnel whose
 * every relayed session read answers 503.
 */

import type { DaemonFetch } from "../daemon-request"
import type { HostConnectorServing } from "./child-protocol"

export function setupHostServingPush(input: {
  daemon: DaemonFetch
  log: { info(message: string): void; warn(message: string): void }
}): (serving: HostConnectorServing) => Promise<void> {
  return async (serving) => {
    try {
      const response = await input.daemon("/api/claxedo/host-serving", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          credential: serving.tunnel,
          ...(serving.endpoints ? { endpoints: serving.endpoints } : {}),
        }),
      })
      const body = await response.text()
      // The daemon rejecting the body, or the ack carrying no credential, is
      // visible nowhere else. The endpoints are named, not printed — which two
      // arrived is the fact that decides whether a relayed caller can be
      // admitted.
      input.log.info(
        `[host-serving] pushed credential=${serving.tunnel ? "present" : "null"} `
          + `endpoints=${serving.endpoints ? Object.keys(serving.endpoints).sort().join(",") : "none"}`
          + ` -> ${String(response.status)} ${body.slice(0, 200)}`,
      )
    } catch (error) {
      input.log.warn(`[host-serving] push failed: ${String(error)}`)
    }
  }
}

/**
 * Tells the daemon the control plane rang this machine: someone's access to
 * what it serves may have narrowed, so its runtimes stop reusing authority
 * answers now. A push that fails leaves those answers to lapse on their own,
 * within a minute.
 */
export function setupHostAccessChangedPush(input: {
  daemon: DaemonFetch
  log: { warn(message: string): void }
}): () => Promise<void> {
  return async () => {
    try {
      const response = await input.daemon("/api/claxedo/host-serving/access-changed", { method: "POST" })
      if (!response.ok) input.log.warn(`[host-serving] access-changed -> ${String(response.status)}`)
    } catch (error) {
      input.log.warn(`[host-serving] access-changed push failed: ${String(error)}`)
    }
  }
}

/**
 * Everything main hands the daemon about serving. The last ack's serving facts
 * are retained so a daemon that becomes ready AFTER the first ack still starts
 * serving immediately, with the addresses that ack named, not just its
 * credential.
 */
export function setupHostServingDelivery(input: {
  daemon: DaemonFetch
  daemonReady: Promise<unknown>
  log: { info(message: string): void; warn(message: string): void }
}) {
  const send = setupHostServingPush(input)
  let last: HostConnectorServing | undefined
  const serving = async (next: HostConnectorServing) => {
    last = next
    await send(next)
  }
  void input.daemonReady.then(
    () => {
      if (last) void serving(last)
    },
    // A daemon that never became reachable is already reported by the startup
    // path; this retry has nothing left to push and must not become an
    // unhandled rejection on the way to saying so.
    () => {},
  )
  return { serving, accessChanged: setupHostAccessChangedPush(input) }
}
