export const conversionEventNames = ["open_claxedo", "deploy_cloudflare", "download_app", "explore_framework"] as const
export type ConversionEventName = (typeof conversionEventNames)[number]

export const conversionRoutes = ["/", "/app", "/compare", "/download", "/framework", "/pricing", "/404"] as const

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
  const platform = bounded(input.platform, /^(macos-arm64|macos-x64|windows-x64|linux-deb|linux-rpm)$/)
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
