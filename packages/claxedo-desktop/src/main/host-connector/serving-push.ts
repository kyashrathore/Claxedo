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

import type { HostConnectorServing } from "./child-protocol"

export function setupHostServingPush(input: {
  serverUrl: () => Promise<string>
  request?: (url: string, init?: RequestInit) => Promise<Response>
  log: { info(message: string): void; warn(message: string): void }
}): (serving: HostConnectorServing) => Promise<void> {
  const request = input.request ?? fetch
  return async (serving) => {
    try {
      const response = await request(new URL("/api/claxedo/host-serving", await input.serverUrl()).toString(), {
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
