export const publicOrigin = "https://claxedo.com"

export const routes = {
  home: "/",
  app: "https://app.claxedo.com",
  pricing: "/pricing",
  download: "/download",
  framework: "/framework",
  deploy: "/framework/deploy/cloudflare-full-stack",
  compare: "/compare",
  privacy: "/privacy",
  terms: "/terms",
  start: "/start.md",
  llms: "/llms.txt",
} as const

/**
 * The CTAs the site actually renders. `cloud` ("Open Claxedo") and `deploy`
 * ("Deploy to Cloudflare") used to live here and were removed once no page
 * rendered them — an unused action keeps a conversion event name alive in
 * `analytics.ts`, which then reads like a live CTA to anyone auditing what the
 * site collects. Add one back only alongside the page that renders it.
 */
export const marketingActions = {
  download: {
    label: "Download app",
    href: `${routes.download}#releases`,
    event: "download_app",
  },
  framework: {
    label: "Explore the open-source framework",
    href: routes.framework,
    event: "explore_framework",
  },
} as const

export const canonicalUrl = (pathname: string) => new URL(pathname, publicOrigin).href
