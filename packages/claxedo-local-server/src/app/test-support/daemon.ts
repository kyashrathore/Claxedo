/**
 * A daemon identity and the capability that presents it, for tests that mount
 * this composition.
 *
 * The composition requires an identity because it authenticates its application
 * with one, so a test that stands the daemon up holds a real capability and
 * exercises the real gate. A test wanting to prove a caller is REFUSED simply
 * omits the header — that is the hostile-origin case, not a special mode.
 */

import { randomUUID } from "node:crypto"
import { DAEMON_CAPABILITY_HEADER } from "../daemon-admission"
import { createLocalDaemonLifecycle } from "../local-daemon-lifecycle"
import type { LocalAppOptions } from "../local-app"

export type TestDaemon = {
  daemon: LocalAppOptions["daemon"]
  token: string
  /** Spread onto a request's headers to call as the application. */
  capability: Record<string, string>
  /**
   * `fetch` as the application. Caller headers are applied last, so a test that
   * wants to present a forged or absent capability can still say so.
   */
  call: (url: string | URL, init?: RequestInit) => Promise<Response>
}

/**
 * A socket opened the way Electron main opens the renderer's: the capability
 * rides on the HTTP upgrade, which is the only place a WebSocket can carry it.
 *
 * The DOM lib's constructor signature knows only the subprotocol list, while
 * the runtime's WebSocket takes undici's options bag. The cast is here, once,
 * rather than at each test that needs a real socket past the gate.
 */
export function openDaemonSocket(url: string, capability: Record<string, string>): WebSocket {
  const WithHeaders = WebSocket as unknown as new (
    url: string,
    options: { headers: Record<string, string> },
  ) => WebSocket
  return new WithHeaders(url, { headers: capability })
}

export function testDaemon(): TestDaemon {
  const token = `daemon-capability-${randomUUID()}`
  const capability = { [DAEMON_CAPABILITY_HEADER]: token }
  return {
    token,
    capability,
    call: (url, init = {}) =>
      fetch(url, { ...init, headers: { ...capability, ...Object.fromEntries(new Headers(init.headers)) } }),
    daemon: {
      identity: { token, protocol: 1, generation: `generation-${randomUUID()}`, pid: process.pid },
      lifecycle: createLocalDaemonLifecycle({ onIdle: () => {} }),
    },
  }
}
