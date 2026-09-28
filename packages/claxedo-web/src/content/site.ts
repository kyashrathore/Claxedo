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
  headline: "Set up your coding agents once. Run them anywhere.",
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

/** Every point names the claims that back it; the home page refuses to build if one is not publishable. */
export const home = {
  openInBrowser: { label: "Open in browser", href: routes.app },
  points: [
    {
      title: "Every coding agent, one app",
      line: "Claude Code, Codex, Cursor, OpenCode, Pi and any ACP agent.",
      claims: ["harness-coverage", "acp-client"],
    },
    {
      title: "Set up once",
      line: "Your skills, plugins and MCP servers reach Claude Code, Codex, Cursor and OpenCode.",
      claims: ["agent-plugins"],
    },
    {
      title: "Run anywhere",
      line: "Your laptop, your other machines or a cloud sandbox. Reopen the same session from desktop or browser.",
      claims: ["connected-placement"],
    },
    {
      title: "Fast and light, measured in public",
      line: "Starts 2.6–3× faster than T3 Code and OpenCode, opens sessions up to 3.3× faster, and idles at 0.2% CPU with 30–48% less memory. T3 Code is faster reopening a small session.",
      link: { label: "See every result", href: benchmarkUrl },
      claims: ["open-benchmark"],
    },
    {
      title: "Open source and free",
      line: "MIT licensed. Local mode needs no account, and it is free during beta.",
      claims: ["mit-platform", "desktop-local-mode", "free-beta"],
    },
  ] satisfies readonly HomePoint[],
} as const

export const commercialNavigation = [
  { label: "Pricing", href: routes.pricing, key: "pricing" },
  { label: "Download", href: routes.download, key: "download" },
  { label: "Compare", href: routes.compare, key: "compare" },
] as const

export const approvedMarketingActions = [marketingActions.download]
