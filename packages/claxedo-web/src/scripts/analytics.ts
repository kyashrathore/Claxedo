/**
 * The complete set of conversion events the site can emit. This list is an
 * allowlist, not a wish list: an entry with no element carrying the matching
 * `data-analytics-event` is dead weight that reads, to anyone auditing what we
 * collect, like a CTA that exists. `open_claxedo` and `deploy_cloudflare` were
 * exactly that — kept here long after their buttons were removed — so the rule
 * now is that a name lands here in the same change as the element that fires it.
 */
export const conversionEventNames = ["download_app", "explore_framework"] as const
export type ConversionEventName = (typeof conversionEventNames)[number]

export const conversionRoutes = [
  "/",
  "/app",
  "/compare",
  "/download",
  "/framework",
  "/how-often-do-coding-agents-need-a-full-machine",
  "/pricing",
  "/404",
] as const

export const conversionRoute = (pathname: string) => {
  const route = pathname.replace(/\/$/, "") || "/"
  if (route.startsWith("/framework/")) return "/framework"
  if (route.startsWith("/compare/")) return "/compare"
  return conversionRoutes.find((candidate) => candidate === route)
}

export type ConversionEvent = {
  name: ConversionEventName
  route: string
  placement: string
  platform?: string
  version?: string
}

type EventInput = {
  name?: string
  route: string
  placement?: string
  platform?: string
  version?: string
}

const bounded = (value: string | undefined, pattern: RegExp) => value && pattern.test(value) ? value : undefined

export const buildConversionEvent = (input: EventInput): ConversionEvent | undefined => {
  if (!conversionEventNames.includes(input.name as ConversionEventName)) return
  const placement = bounded(input.placement, /^[a-z0-9-]{1,64}$/)
  const route = conversionRoute(input.route.split("?")[0])
  if (!placement || !route) return
  // Keep in sync with the `downloads` platform ids in src/config.ts — an id
  // missing here is silently stripped from the conversion event, not rejected.
  const platform = bounded(
    input.platform,
    /^(macos-arm64|macos-x64|windows-x64|linux-appimage|linux-deb|linux-rpm|linux-arm64-appimage|linux-arm64-deb|linux-arm64-rpm)$/,
  )
  const version = bounded(input.version, /^\d+\.\d+\.\d+$/)
  return { name: input.name as ConversionEventName, route, placement, ...(platform && { platform }), ...(version && { version }) }
}

declare global {
  interface Window {
    claxedoAnalytics?: { track: (event: ConversionEvent) => void | Promise<void> }
    __claxedoAnalyticsEvents?: ConversionEvent[]
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("click", (event) => {
    const target = (event.target as Element | null)?.closest<HTMLElement>("[data-analytics-event]")
    if (!target) return
    const conversion = buildConversionEvent({
      name: target.dataset.analyticsEvent,
      route: new URL(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? "/404", window.location.origin).pathname,
      placement: target.dataset.analyticsPlacement,
      platform: target.dataset.analyticsPlatform,
      version: target.dataset.analyticsVersion,
    })
    if (!conversion) return
    window.__claxedoAnalyticsEvents ??= []
    window.__claxedoAnalyticsEvents.push(conversion)
    void Promise.resolve()
      .then(() => window.claxedoAnalytics?.track(conversion))
      .catch(() => undefined)
  }, { capture: true })
}
