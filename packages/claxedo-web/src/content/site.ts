import { marketingActions, routes } from "./routes"

export const site = {
  name: "Claxedo",
  category: "Connected agent workspace",
  headline: "The open-source workspace for coding agents.",
  description:
    "Run Claude Code, Codex, Gemini CLI, OpenCode, and any coding-agent CLI across first-class sessions and terminals. Organize parallel agent work with WorkGraph, locally or on infrastructure you choose.",
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
  { label: "WorkGraph", href: "/#workgraph" },
  { label: "How it works", href: "/#how-it-works" },
  { label: "Pricing", href: routes.pricing },
  { label: "Why Claxedo", href: "/#principles" },
] as const

export const approvedMarketingActions = Object.values(marketingActions)
