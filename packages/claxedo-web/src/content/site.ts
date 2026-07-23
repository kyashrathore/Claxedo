import { marketingActions, routes } from "./routes"

export const site = {
  name: "Claxedo",
  category: "Open cloud workspace",
  headline: "The open cloud workspace for coding agents.",
  description:
    "Use Claxedo Cloud or deploy the open control plane to your Cloudflare account. Run Claude Code, Codex, OpenCode, and other coding agents across connected workspace runtimes you control.",
  freeBeta: "Free during beta",
  localMode: "Local mode works without an account",
  product: {
    name: "Claxedo",
    destination: routes.home,
  },
  clients: {
    web: { name: "Claxedo Web", destination: "https://app.claxedo.com" },
    desktop: { name: "Claxedo Desktop", destination: routes.download },
  },
  framework: {
    name: "Claxedo Framework",
    destination: routes.framework,
  },
  hostedDescriptor: "Claxedo Cloud",
} as const

export const commercialNavigation = [
  { label: "Product", href: "/#product" },
  { label: "Architecture", href: "/#architecture" },
  { label: "WorkGraph", href: "/#workgraph" },
  { label: "Pricing", href: routes.pricing },
  { label: "Framework", href: routes.framework },
  { label: "Download", href: routes.download },
] as const

export const approvedMarketingActions = [marketingActions.cloud, marketingActions.deploy]
