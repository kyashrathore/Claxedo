import { github } from "../config"
import { marketingActions, routes } from "./routes"

/** `spot` names the part of the home page's app demo that a line lights up on hover. */
export type HomeLine = {
  text: string
  proof?: { label: string; href: string }
  spot?: "plugin" | "team" | "place" | "tools" | "terminal"
  claims: readonly string[]
}

export const benchmarkUrl = "https://github.com/kyashrathore/agent-app-benchmark"

export const site = {
  name: "Claxedo",
  category: "The coding agent workspace",
  headline: "Claude Code, Codex, Cursor, OpenCode, Pi. One app.",
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

/** Every line names the claims behind it; the home page refuses to build if one is not publishable. */
export const home = {
  headline: { text: site.headline, claims: ["harness-coverage"] },
  lines: [
    {
      text: "Starts 2.5× faster than T3 Code and OpenCode",
      proof: { label: "See the benchmark", href: benchmarkUrl },
      claims: ["open-benchmark"],
    },
    {
      text: "Build your own features with a prompt",
      spot: "plugin",
      claims: ["app-plugins-by-prompt"],
    },
    {
      text: "Self-host for your team on Cloudflare",
      proof: { label: "Read the deployment guide", href: `${github}/blob/dev/public-docs/user-deployed-cloudflare.md` },
      spot: "team",
      claims: ["user-deployed-cloudflare"],
    },
    {
      text: "Any machine. Any sandbox.",
      proof: { label: "Read the sandbox adapter contract", href: `${github}/blob/dev/packages/sandbox-manager/docs/architecture.md` },
      spot: "place",
      claims: ["sandbox-providers", "connected-placement"],
    },
    {
      text: "Your tools follow you everywhere",
      spot: "tools",
      claims: ["agent-plugins", "agent-plugins-follow-you"],
    },
    {
      text: "Chat or terminal. Your call.",
      spot: "terminal",
      claims: ["harness-coverage", "acp-client", "agent-cli-access"],
    },
  ] satisfies readonly HomeLine[],
} as const

export const commercialNavigation = [
  { label: "Pricing", href: routes.pricing, key: "pricing" },
  { label: "Download", href: routes.download, key: "download" },
  { label: "Compare", href: routes.compare, key: "compare" },
] as const

export const approvedMarketingActions = [marketingActions.download]
