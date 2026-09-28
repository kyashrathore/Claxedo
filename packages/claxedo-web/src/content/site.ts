import { github } from "../config"
import { marketingActions, routes } from "./routes"

export type HomePoint = {
  title: string
  line: string
  link?: { label: string; href: string }
  claims: readonly string[]
}

export const benchmarkUrl = "https://github.com/kyashrathore/agent-app-benchmark"

export const site = {
  name: "Claxedo",
  category: "The coding agent workspace",
  headline: "Every coding agent. One fast app. Anywhere you work.",
  description:
    "One open-source app for Claude Code, Codex, Cursor, OpenCode, Pi and any ACP agent. Set up skills, plugins and MCP servers once, and run sessions on your laptop, your other machines or a cloud sandbox.",
  freeBeta: "Free during beta",
  localMode: "Local mode works without an account",
  product: {
    name: "Claxedo",
    destination: routes.home,
  },
  clients: {
    web: { name: "Claxedo Web", destination: routes.app },
    desktop: { name: "Claxedo Desktop", destination: routes.download },
  },
  hostedDescriptor: "Claxedo Cloud",
} as const

/** Every point and the trust line name the claims behind them; the home page refuses to build if one is not publishable. */
export const home = {
  openInBrowser: { label: "Open in browser", href: routes.app },
  trust: {
    items: ["Open source (MIT)", "Works locally without an account", "Free during beta"],
    claims: ["mit-platform", "desktop-local-mode", "free-beta"],
  },
  points: [
    {
      title: "Faster than T3 Code and OpenCode",
      line: "In an open, reproducible benchmark: 2.6–3× quicker starts, session opens up to 3.3× faster, 30–48% less memory and 0.2% idle CPU. T3 Code is quicker returning to a small session.",
      link: { label: "See every result", href: benchmarkUrl },
      claims: ["open-benchmark"],
    },
    {
      title: "Make it yours with a prompt",
      line: "Describe the page, pane or command you want. Your agent builds it as an app plugin, and once you approve it, every change goes live.",
      claims: ["app-plugins-by-prompt"],
    },
    {
      title: "Self-host it for your team",
      line: "Deploy your own Claxedo to your Cloudflare account, and your team signs in to one organization.",
      link: { label: "Deployment guide", href: `${github}/blob/dev/public-docs/user-deployed-cloudflare.md` },
      claims: ["user-deployed-cloudflare"],
    },
    {
      title: "Runs where your code runs",
      line: "Your laptop, any machine you connect, or any sandbox provider: Daytona, Modal, Vercel, Cloudflare, Docker or your own adapter. Pick up the same session on desktop, browser or phone.",
      link: { label: "Adapter contract", href: `${github}/blob/dev/packages/sandbox-manager/docs/architecture.md` },
      claims: ["sandbox-providers", "connected-placement"],
    },
    {
      title: "Tools that follow you",
      line: "Enable skills, plugins and MCP servers once, and they reach Claude Code, Codex, Cursor and OpenCode in every environment you sign into.",
      claims: ["agent-plugins", "agent-plugins-follow-you"],
    },
    {
      title: "Chat or terminal",
      line: "A rich chat UI for every agent, or a real terminal for any agent CLI.",
      claims: ["harness-coverage", "acp-client", "agent-cli-access"],
    },
  ] satisfies readonly HomePoint[],
} as const

export const commercialNavigation = [
  { label: "Pricing", href: routes.pricing, key: "pricing" },
  { label: "Download", href: routes.download, key: "download" },
  { label: "Compare", href: routes.compare, key: "compare" },
] as const

export const approvedMarketingActions = [marketingActions.download]
