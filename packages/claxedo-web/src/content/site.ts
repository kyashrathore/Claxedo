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
    title: "Fast, light and efficient.",
    subtitle: "Faster than T3 Code and OpenCode on every core metric, and it idles at 0% CPU. Measured in the open Agent App Benchmark on 28 September 2026.",
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
  rows: [
    {
      id: "prompt",
      title: "Extend it with a prompt.",
      text: "Ask an agent for the feature you're missing. It builds an app plugin, and Claxedo runs it once you turn it on.",
      claims: ["app-plugins-by-prompt"],
    },
    {
      id: "cloudflare",
      title: "Open source. On your Cloudflare in minutes.",
      text: "MIT licensed. Deploy the control plane for your team to your own Cloudflare account.",
      href: `${github}/blob/dev/public-docs/user-deployed-cloudflare.md`,
      claims: ["mit-platform", "user-deployed-cloudflare"],
    },
    {
      id: "sandbox",
      title: "Bring your own sandbox.",
      text: "Run sessions on this computer, your other machines, or Daytona, Modal, Vercel, Cloudflare, exe.dev, Box and Docker. Every one of them runs behind the same open driver contract.",
      claims: ["connected-placement", "sandbox-providers"],
    },
    {
      id: "plugins",
      title: "Configure agent plugins once.",
      text: "Turn on a skill or MCP server once, and it reaches every machine and sandbox you sign into, for Claude Code, Codex, Cursor and OpenCode.",
      claims: ["agent-plugins", "agent-plugins-follow-you"],
    },
    {
      id: "terminal",
      title: "GUI or terminal. Sidebar or tabs.",
      text: "Talk to agents in Claxedo's chat, or run any agent CLI you've installed in a terminal beside it. Keep sessions in a sidebar or open them as tabs.",
      claims: ["sessions-and-terminals", "agent-cli-access", "harness-coverage", "sidebar-or-tabs"],
    },
  ],
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
