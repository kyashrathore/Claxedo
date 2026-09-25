import { expect, type Page, type Request } from "@playwright/test"

const STATIC_ASSET = /\.(js|css|woff2?|svg|png|ico|map)(\?|$)|\/@vite\/|\/src\/|\/node_modules\//

const EVENT_STREAM = /\/api\/(wr|cp)\/events/

export function apiRequests(app: Page, origin: string) {
  let seen: string[] = []
  const inFlight = new Set<Request>()
  const counted = (request: Request) => {
    const url = request.url()
    return url.startsWith(origin) && !STATIC_ASSET.test(url) && !EVENT_STREAM.test(url) && request.resourceType() !== "document"
  }
  app.on("request", (request) => {
    if (!counted(request)) return
    inFlight.add(request)
    const parsed = new URL(request.url())
    const harness = parsed.searchParams.get("nativeHarness") ?? parsed.searchParams.get("connectionId")
    seen.push(`${parsed.pathname.replace(/ses_[\w-]+/g, ":session")}${harness ? `?${harness}` : ""}`)
  })
  app.on("requestfinished", (request) => inFlight.delete(request))
  app.on("requestfailed", (request) => inFlight.delete(request))
  const idle = () => app.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestIdleCallback(() => resolve())))))
  return async () => {
    for (let quiet = 0; quiet < 2; ) {
      await expect.poll(() => [...inFlight].map((request) => request.url())).toEqual([])
      await idle()
      quiet = inFlight.size === 0 ? quiet + 1 : 0
    }
    const taken = seen
    seen = []
    return taken
  }
}
