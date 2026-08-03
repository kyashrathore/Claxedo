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

export const marketingActions = {
  cloud: {
    label: "Open Claxedo",
    href: routes.app,
    event: "open_claxedo",
  },
  deploy: {
    label: "Deploy to Cloudflare",
    href: routes.deploy,
    event: "deploy_cloudflare",
  },
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
