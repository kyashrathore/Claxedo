import { github } from "../config"
import { marketingActions, routes } from "./routes"

/**
 * `id` picks the line's voice on the home stage and the state the app demo moves to while it plays.
 * `cycles` lists true alternatives a word flips through before it settles.
 */
export type HomeLine = {
  id: "speed" | "prompt" | "team" | "place" | "tools" | "terminal"
  text: string
  proof?: { label: string; href: string }
  cycles?: Readonly<Record<string, readonly string[]>>
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
      id: "speed",
      text: "Starts 2.5× faster than T3 Code and OpenCode",
      proof: { label: "See the benchmark", href: benchmarkUrl },
      claims: ["open-benchmark"],
    },
    {
      id: "prompt",
      text: "Build your own features with a prompt",
      claims: ["app-plugins-by-prompt"],
    },
    {
      id: "team",
      text: "Self-host for your team on Cloudflare",
      proof: { label: "Read the deployment guide", href: `${github}/blob/dev/public-docs/user-deployed-cloudflare.md` },
      claims: ["user-deployed-cloudflare"],
    },
    {
      id: "place",
      text: "Any machine. Any sandbox.",
      proof: { label: "Read the sandbox adapter contract", href: `${github}/blob/dev/packages/sandbox-manager/docs/architecture.md` },
      cycles: { "machine.": ["laptop", "server", "desktop"], "sandbox.": ["Daytona", "Modal", "Vercel", "Docker"] },
      claims: ["sandbox-providers", "connected-placement"],
    },
    {
      id: "tools",
      text: "Your tools follow you everywhere",
      claims: ["agent-plugins", "agent-plugins-follow-you"],
    },
    {
      id: "terminal",
      text: "Chat or terminal. Your call.",
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
