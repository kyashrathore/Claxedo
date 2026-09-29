import { benchmark, downloads, github } from "../config"
import { marketingActions, routes } from "./routes"

export const site = {
  name: "Claxedo",
  category: "The coding agent workspace",
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

/** Every block names the claims behind its words; the home page refuses to build if one is not publishable. */
export const home = {
  hero: {
    title: "Every coding agent, in one fast app.",
    subtitle: "Claude Code, Codex, Cursor, OpenCode and Pi, with your tools, on any machine.",
    claims: ["harness-coverage", "acp-client", "agent-cli-access", "core-metrics", "agent-plugins", "connected-placement"],
  },
  benchmark: {
    title: "Faster than T3 Code and OpenCode on every core metric.",
    subtitle: "Measured in the open Agent App Benchmark on 28 September 2026.",
    href: `${benchmark}#latest-results`,
    claims: ["core-metrics"],
    metrics: [
      { lead: "2.3×", label: "faster start", detail: "0.98 s. 2.9× faster than T3 Code, 2.3× faster than OpenCode." },
      { lead: "2.6×", label: "faster session open", detail: "45 ms. 3.1× faster than T3 Code, 2.6× faster than OpenCode." },
      { lead: "2.1×", label: "faster return", detail: "27 ms. 2.5× faster than T3 Code, 2.1× faster than OpenCode." },
      { lead: "1.8×", label: "less memory", detail: "750 MiB. 1.8× less than T3 Code, 2.1× less than OpenCode." },
      { lead: "0%", label: "idle CPU", detail: "T3 Code idles at 1.6%, OpenCode at 20.4%." },
    ],
  },
  place: {
    title: "Any machine. Any sandbox.",
    subtitle: "Run a session where the work belongs, and reopen it from anywhere.",
    panels: [
      {
        title: "This computer, your machines, or a sandbox.",
        text: "Connect another computer with the Claxedo CLI, or start a cloud sandbox on Daytona, Modal, Vercel, Cloudflare, exe.dev, Box or Docker. Every driver implements one open contract.",
        claims: ["connected-placement", "sandbox-providers"],
      },
      {
        title: "Five agents, built in.",
        text: "Pick Claude Code, Codex, Cursor, OpenCode or Pi, then its model and effort, from the same composer. Any ACP agent can join them.",
        claims: ["harness-coverage", "acp-client"],
      },
    ],
  },
  features: [
    {
      id: "prompt",
      title: "Build your own features with a prompt",
      text: "Ask an agent for a page. It builds an app plugin, and the app runs it once you turn it on.",
      claims: ["app-plugins-by-prompt"],
    },
    {
      id: "team",
      title: "Self-host for your team on Cloudflare",
      text: "Deploy the open control plane for your organization to your own Cloudflare account.",
      href: `${github}/blob/dev/public-docs/user-deployed-cloudflare.md`,
      claims: ["user-deployed-cloudflare", "mit-platform"],
    },
    {
      id: "tools",
      title: "Your tools follow you everywhere",
      text: "Turn on a skill or MCP server once. It reaches this computer, your machines and your sandboxes.",
      claims: ["agent-plugins", "agent-plugins-follow-you"],
    },
  ],
  terminal: {
    title: "Chat or terminal. Your call.",
    text: "Talk to an agent in Claxedo's chat, or open a terminal beside it and run any agent CLI you have installed.",
    claims: ["sessions-and-terminals", "agent-cli-access", "harness-coverage"],
  },
  closing: {
    text: "Open source under MIT. Works locally without an account.",
    claims: ["mit-platform", "desktop-local-mode"],
  },
} as const

/** The pill that downloads the Apple Silicon build directly; every other build is one click away on the download page. */
export const macDownload = downloads.find((download) => download.platform === "macos-arm64")!

export const commercialNavigation = [
  { label: "Pricing", href: routes.pricing, key: "pricing" },
  { label: "Download", href: routes.download, key: "download" },
  { label: "Compare", href: routes.compare, key: "compare" },
] as const

export const approvedMarketingActions = [marketingActions.download]
