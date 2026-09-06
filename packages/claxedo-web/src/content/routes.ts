export const publicOrigin = "https://claxedo.com"

export const routes = {
  home: "/",
  app: "https://app.claxedo.com",
  pricing: "/pricing",
  download: "/download",
  agentRuntimeStudy: "/how-often-do-coding-agents-need-a-full-machine",
  compare: "/compare",
  about: "/about",
  contact: "/contact",
  privacy: "/privacy",
  terms: "/terms",
  start: "/start.md",
  llms: "/llms.txt",
} as const

/**
 * The CTAs the site actually renders. Add an entry only alongside the page
 * that renders it — an unused action keeps its conversion event name alive in
 * `analytics.ts`, which then reads like a live CTA to anyone auditing what the
 * site collects.
 */
export const marketingActions = {
  download: {
    label: "Download app",
    href: `${routes.download}#releases`,
    event: "download_app",
  },
} as const

export const canonicalUrl = (pathname: string) => new URL(pathname, publicOrigin).href
