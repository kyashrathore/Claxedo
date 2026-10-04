/**
 * The embedded server's readiness boundary.
 *
 * TWO HALVES, AND NEITHER SUBSTITUTES FOR THE OTHER. The child reports over IPC
 * that its listen callback fired (`claxedo-server-lifecycle.ts`), and then this
 * verifies that the thing which said it is listening actually answers. The
 * verification is not redundant with the message: at the initial release main
 * had no message at all and POLLED health 50 x 100 ms, so the poll WAS the
 * readiness signal. The message replaced the POLLING, not the CHECKING — a
 * child that binds a socket and then fails to serve (a route tree that did not
 * mount, a local request guard that rejects its own owner, or a stranger
 * already holding the port) is still a listening-but-broken server, and only an
 * answered request rules it out. Its failure is load-bearing: `main/index.ts`
 * kills the child and rejects `serverReady`, so the renderer shows a startup
 * error instead of a shell wired to a dead server.
 *
 * WHY `prepare()` EXISTS. `verify()` is the FIRST `fetch` this process makes, so
 * it pays the HTTP client's one-time initialisation on top of its round trip.
 * Measured standalone under the shipped Electron 43, against a trivial loopback
 * JSON route: 12.5-12.9 ms for the first request versus 1.5-1.6 ms when the
 * initialisation has already been paid. That ~11 ms is not spent anywhere
 * harmless — it lands AFTER the child reports listening and BEFORE main
 * publishes the server URL, and the renderer is already blocked on that publish
 * (`renderer/shell.tsx` `ServerGate` -> `awaitInitialization` ->
 * `serverReady.promise`), with a measured >=94 ms of slack in every healthy
 * benchmark run. So it is ~11 ms of pure serial startup in front of an idle
 * renderer.
 *
 * `prepare()` moves that initialisation into the window where main is blocked
 * on the child and has nothing else to do. It issues the SAME GET to the SAME
 * URL `verify()` will, so it adds no exposure the check does not already have;
 * the child has not bound the port yet, so it is refused at once and discarded.
 * It is fire-and-forget and swallowing: it can never fail, delay, or gate
 * anything, and `verify()` behaves identically whether or not it ran.
 */

type HealthResponse = { ok: boolean; status: number }
type HealthFetch = (url: string, init: { signal: AbortSignal }) => Promise<HealthResponse>

export type EmbeddedServerReadiness = {
  /** Pay the HTTP client's one-time cost early. Never throws, never awaited. */
  prepare: () => void
  /** Resolve once the server answers; reject with a named reason otherwise. */
  verify: () => Promise<void>
}

export function embeddedServerReadiness(input: {
  healthUrl: string
  timeoutMs?: number
  fetch?: HealthFetch
}): EmbeddedServerReadiness {
  const timeoutMs = input.timeoutMs ?? 1_000
  const request: HealthFetch = input.fetch ?? ((url, init) => fetch(url, init))
  const send = () => request(input.healthUrl, { signal: AbortSignal.timeout(timeoutMs) })
  return {
    prepare: () => {
      try {
        void send().catch(() => undefined)
      } catch {
        // Structural, not defensive: `prepare` is a diagnostic-grade
        // optimisation, so "cannot fail" must be a property of the code rather
        // than a property of `fetch` never throwing synchronously.
      }
    },
    verify: async () => {
      const response = await send()
      if (!response.ok) {
        throw new Error(`The embedded Claxedo server health check returned ${String(response.status)}.`)
      }
    },
  }
}
