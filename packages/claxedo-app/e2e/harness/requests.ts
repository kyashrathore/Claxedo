import { expect, test, type Page, type Request, type Route } from "@playwright/test"

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

export async function holdResponse(app: Page, pattern: RegExp, matches: (url: URL) => boolean = () => true) {
  const computed = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const delivered = Promise.withResolvers<PromiseSettledResult<void>>()
  let captured = false
  const handler = async (route: Route) => {
    if (captured || !matches(new URL(route.request().url()))) return await route.fallback()
    captured = true
    const response = await route.fetch()
    computed.resolve()
    await released.promise
    const [outcome] = await Promise.allSettled([route.fulfill({ response })])
    delivered.resolve(outcome)
  }
  await app.route(pattern, handler)
  return {
    computed: computed.promise,
    release: async () => {
      released.resolve()
      const outcome = await delivered.promise
      if (outcome.status === "rejected") test.info().annotations.push({ type: "abandoned held read", description: String(outcome.reason) })
      expect(outcome.status, "the app received the held read").toBe("fulfilled")
    },
  }
}

export async function holdEveryRequest(app: Page, pattern: RegExp) {
  const released = Promise.withResolvers<void>()
  const held: string[] = []
  await app.route(pattern, async (route: Route) => {
    if (route.request().isNavigationRequest()) return await route.fallback()
    const url = new URL(route.request().url())
    held.push(`${url.pathname}${url.search}`)
    await released.promise
    await route.fallback()
  })
  return { held: () => [...held], release: () => released.resolve() }
}
