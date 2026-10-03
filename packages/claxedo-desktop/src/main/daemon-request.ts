/**
 * The one way Electron main calls its own daemon.
 *
 * Main is behind every machine-control write the daemon accepts, and a
 * capability each caller attaches for itself is one the next caller forgets —
 * so callers take this function rather than `fetch`. It differs from the bare
 * global in three ways that are all about where the capability can end up:
 *
 *   - the destination is pinned to the daemon's own origin, so a caller handed
 *     a URL rather than a path cannot send it elsewhere;
 *   - redirects are an error, never a second request carrying these headers to
 *     whatever `Location` named;
 *   - a caller's own capability header is dropped before this one is set.
 *
 * The daemon reads the one published secret from two headers: the admission
 * gate ahead of every route family reads the capability, and the lifecycle
 * routes exempted from that gate authenticate the same secret as a bearer. Both
 * are set here for the same reason the capability is — a caller that attaches
 * one for itself is a caller the next one forgets, and the lifecycle routes
 * answer a missing bearer with 401 rather than anything that names the cause. A
 * caller that brings its own `Authorization` keeps it: a signed desktop carries
 * a control-plane token there.
 */

export const CLAXEDO_DAEMON_CAPABILITY_HEADER = "x-claxedo-daemon-capability"

export type DaemonEndpoint = {
  origin: string
  /**
   * Absent when main is pointed at a server whose daemon identity it was never
   * given — a development or custom-URL connection. The daemon then refuses the
   * privileged routes, which is the visible answer rather than a silent one.
   */
  capability: string | undefined
}

export type DaemonFetch = (path: string, init?: RequestInit) => Promise<Response>

/**
 * What this function sends on, narrowed to what it actually sends: a resolved
 * `URL` and an init it built. The global `fetch` satisfies it, and a double
 * written to it needs no cast to pretend otherwise.
 */
export type DaemonTransport = (url: URL, init: RequestInit) => Promise<Response>

export function createDaemonFetch(input: {
  endpoint: () => DaemonEndpoint | Promise<DaemonEndpoint>
  fetch?: DaemonTransport
}): DaemonFetch {
  const request = input.fetch ?? fetch
  return async (path, init) => {
    const { origin, capability } = await input.endpoint()
    const base = new URL(origin)
    const url = new URL(path, base)
    if (url.origin !== base.origin) {
      throw new Error(`refusing to present the daemon capability to ${url.origin}; this daemon is ${base.origin}`)
    }
    const headers = new Headers(init?.headers)
    headers.delete(CLAXEDO_DAEMON_CAPABILITY_HEADER)
    if (capability) {
      headers.set(CLAXEDO_DAEMON_CAPABILITY_HEADER, capability)
      if (!headers.has("authorization")) headers.set("authorization", `Bearer ${capability}`)
    }
    return await request(url, { ...init, headers, redirect: "error" })
  }
}
