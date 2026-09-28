import { github } from "../config"
import { marketingActions, routes } from "./routes"

/**
 * `id` picks the state the home page's app demo moves to while the line plays.
 * `loud` is the part of `text` set at full strength; the rest is muted.
 */
export type HomeLine = {
  id: "speed" | "prompt" | "team" | "place" | "tools" | "terminal"
  text: string
  loud: string
  proof?: { label: string; href: string }
  claims: readonly string[]
}

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

/** Every line and the benchmark strip name the claims behind them; the home page refuses to build if one is not publishable. */
export const home = {
  lines: [
    {
      id: "speed",
      text: "Beats T3 Code and OpenCode on every core metric",
      loud: "Beats T3 Code and OpenCode",
      claims: ["core-metrics"],
    },
    {
      id: "prompt",
      text: "Build your own features with a prompt",
      loud: "Build your own features",
      claims: ["app-plugins-by-prompt"],
    },
    {
      id: "team",
      text: "Self-host for your team on Cloudflare",
      loud: "Self-host",
      proof: { label: "Deployment guide", href: `${github}/blob/dev/public-docs/user-deployed-cloudflare.md` },
      claims: ["user-deployed-cloudflare"],
    },
    {
      id: "place",
      text: "Any machine. Any sandbox.",
      loud: "Any machine.",
      proof: { label: "Sandbox adapter contract", href: `${github}/blob/dev/packages/sandbox-manager/docs/architecture.md` },
      claims: ["sandbox-providers", "connected-placement"],
    },
    {
      id: "tools",
      text: "Your tools follow you everywhere",
      loud: "follow you everywhere",
      claims: ["agent-plugins", "agent-plugins-follow-you"],
    },
    {
      id: "terminal",
      text: "Chat or terminal. Your call.",
      loud: "Chat or terminal.",
      claims: ["harness-coverage", "acp-client", "agent-cli-access"],
    },
  ] satisfies readonly HomeLine[],
  benchmark: {
    line: "speed",
    claims: ["core-metrics"],
    metrics: [
      { name: "App start", value: "0.98 s", compare: ["2.9× vs T3", "2.3× vs OpenCode"] },
      { name: "Session open", value: "45 ms", compare: ["3.1× vs T3", "2.6× vs OpenCode"] },
      { name: "Session return", value: "27 ms", compare: ["2.5× vs T3", "2.1× vs OpenCode"] },
      { name: "Memory", value: "750 MiB", compare: ["1.8× less than T3", "2.1× less than OpenCode"] },
      { name: "Idle CPU", value: "0.0%", compare: ["T3 1.6%", "OpenCode 20.4%"] },
    ],
  },
} as const

export const commercialNavigation = [
  { label: "Pricing", href: routes.pricing, key: "pricing" },
  { label: "Download", href: routes.download, key: "download" },
  { label: "Compare", href: routes.compare, key: "compare" },
] as const

export const approvedMarketingActions = [marketingActions.download]
