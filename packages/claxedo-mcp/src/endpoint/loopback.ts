import { isLoopbackHostname, isLoopbackIpAddress, parseIpAddress, requestPeerAddress } from "@claxedo/helpers"

/**
 * The DNS-rebinding gate for the loopback mount. A page on any origin can
 * make a browser send a request to 127.0.0.1, and a client on another
 * machine can send `Host: 127.0.0.1` to a server bound wide — so the socket
 * peer, not the headers, is the server-observed truth: when the adapter
 * exposes one it must be loopback. The `Host` and `Origin` headers then say
 * where the request claims to be FROM, and both must name loopback; an
 * absent `Origin` is a non-browser client and passes. A request with no
 * resolvable peer at all (in-process fetch, workerd) is decided by the
 * header checks alone.
 */
export function isLoopbackRequest(request: Request): boolean {
  const peer = requestPeerAddress(request)
  if (peer !== undefined) {
    const ip = parseIpAddress(peer)
    if (!ip || !isLoopbackIpAddress(ip)) return false
  }
  let hostname: string
  try {
    hostname = new URL(request.url).hostname
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostname)) return false
  const origin = request.headers.get("origin")
  if (!origin) return true
  try {
    return isLoopbackHostname(new URL(origin).hostname)
  } catch {
    return false
  }
}
