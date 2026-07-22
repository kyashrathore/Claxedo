export const publicOrigin = "https://claxedo.com"

export const routes = {
  home: "/",
  pricing: "/pricing",
  download: "/download",
  framework: "/framework",
  compare: "/compare",
  privacy: "/privacy",
  terms: "/terms",
  start: "/start.md",
  llms: "/llms.txt",
} as const

export const marketingActions = {
  download: {
    label: "Download app",
    href: routes.download,
    event: "download_app",
  },
  framework: {
    label: "Explore the open-source framework",
    href: routes.framework,
    event: "explore_framework",
  },
} as const

export const canonicalUrl = (pathname: string) => new URL(pathname, publicOrigin).href
