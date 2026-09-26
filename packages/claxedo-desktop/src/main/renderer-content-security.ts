/**
 * The renderer's Content-Security-Policy, stamped by main onto its own
 * documents. The app runs live plugins in this document, and the policy is what keeps
 * their `fetch`, sockets, beacons and images to the one daemon this window
 * talks to. It cannot be a build-time `<meta>`: the daemon's port is chosen or
 * adopted at launch, and the policy names the exact origin, never a port range.
 *
 * The document response is held until that origin is known. Main learns it when
 * it picks the port or adopts a published daemon, well before the daemon is
 * ready, so the hold overlaps startup instead of adding to it.
 */

import { contentSecurityPolicy } from "@claxedo/app-v2/content-security-policy"

export type HeadersReceivedDetails = {
  url: string
  resourceType: string
  responseHeaders?: Record<string, string[]>
}

export type HeadersReceivedResponse = { responseHeaders?: Record<string, string[]> }

export type RendererContentSecurityOptions = {
  serverOrigin: Promise<string>
  isRendererDocument: (url: string) => boolean
  devServerUrl?: string
}

export function rendererContentSecurityPolicy(serverOrigin: string | undefined, devServerUrl?: string): string {
  const dev = devServerUrl ? new URL(devServerUrl).origin : undefined
  return contentSecurityPolicy({
    servers: [...(serverOrigin ? [serverOrigin] : []), ...(dev ? [dev] : [])],
    // Vite's dev server injects inline modules and evaluates HMR updates.
    scripts: dev ? ["'unsafe-inline'", "'unsafe-eval'"] : [],
    frames: "none",
  })
}

function withPolicy(headers: Record<string, string[]> | undefined, policy: string): Record<string, string[]> {
  const kept = Object.entries(headers ?? {}).filter(([name]) => name.toLowerCase() !== "content-security-policy")
  return { ...Object.fromEntries(kept), "Content-Security-Policy": [policy] }
}

export function rendererContentSecurityListener(options: RendererContentSecurityOptions) {
  return (details: HeadersReceivedDetails, callback: (response: HeadersReceivedResponse) => void) => {
    if (details.resourceType !== "mainFrame" || !options.isRendererDocument(details.url)) {
      callback({})
      return
    }
    options.serverOrigin.then(
      (origin) => callback({ responseHeaders: withPolicy(details.responseHeaders, rendererContentSecurityPolicy(origin, options.devServerUrl)) }),
      () => callback({ responseHeaders: withPolicy(details.responseHeaders, rendererContentSecurityPolicy(undefined, options.devServerUrl)) }),
    )
  }
}
