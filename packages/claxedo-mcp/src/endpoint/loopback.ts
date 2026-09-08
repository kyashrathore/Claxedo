import { isLoopbackHostname } from "@claxedo/helpers"

/**
 * The DNS-rebinding gate for the loopback mount: a page on any origin can
 * make a browser send a request to 127.0.0.1, and only the `Host` and
 * `Origin` headers say where it came from. Both must name loopback; an
 * absent `Origin` is a non-browser client and passes.
 */
export function isLoopbackRequest(request: Request): boolean {
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
