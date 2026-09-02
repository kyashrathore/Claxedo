import { marketingActions, routes } from "./routes"

export const site = {
  name: "Claxedo",
  category: "The coding agent workspace",
  headline: "Set up your coding agents once. Run them anywhere, with anyone.",
  description:
    "Claude Code, Codex, Cursor, and OpenCode in one fast workspace. Your plugins, skills, MCP servers, and credentials follow every agent, on your laptop, in any sandbox.",
  hero: {
    eyebrow: "Open source · MIT · built on the OpenCode engine",
    headline: "Set up your coding agents once. Run them anywhere, with anyone.",
    lead:
      "Your plugins, skills, MCP servers, and credentials follow every agent, on your laptop, in any sandbox.",
  },
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
  hostedDescriptor: "Claxedo Cloud",
} as const

export const commercialNavigation = [
  { label: "Pricing", href: routes.pricing, key: "pricing" },
  { label: "Download", href: routes.download, key: "download" },
  { label: "Compare", href: routes.compare, key: "compare" },
] as const

export const approvedMarketingActions = [marketingActions.download]
