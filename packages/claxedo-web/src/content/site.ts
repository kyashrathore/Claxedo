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
    subtitle: "Claude Code, Codex, Cursor, OpenCode and Pi. Your tools. Any machine.",
    claims: ["harness-coverage", "core-metrics", "agent-plugins", "connected-placement"],
  },
  extend: {
    title: "Fast. Light. Yours to extend.",
    subtitle: "Faster than T3 Code and OpenCode on every core metric. Missing a feature? Prompt it into the app.",
    claims: ["core-metrics", "app-plugins-by-prompt"],
  },
  benchmark: {
    date: "29 September 2026",
    href: `${benchmark}#latest-results`,
    claims: ["core-metrics"],
    metrics: [
      { lead: "2.1×", label: "faster start", detail: "958 ms. 2.9× faster than T3 Code, 2.1× faster than OpenCode." },
      { lead: "2.1×", label: "faster session open", detail: "48 ms. 2.9× faster than T3 Code, 2.1× faster than OpenCode." },
      { lead: "1.5×", label: "faster return", detail: "33 ms. 2.0× faster than T3 Code, 1.5× faster than OpenCode." },
      { lead: "1.8×", label: "less memory", detail: "746 MiB. 1.8× less than T3 Code, 2.0× less than OpenCode." },
      { lead: "6.5×", label: "less idle CPU", detail: "0.4%. 6.5× less than T3 Code, 42× less than OpenCode." },
    ],
  },
  openSource: {
    title: "Open source. Live in 5 minutes.",
    subtitle: "MIT licensed. Deploy it for your whole team on your own Cloudflare.",
    href: `${github}/blob/dev/public-docs/user-deployed-cloudflare.md`,
    claims: ["mit-platform", "cloudflare-five-minutes"],
  },
  sandbox: {
    title: "Bring your own sandbox.",
    subtitle: "Any provider, any machine. Pick up every session on desktop, browser or phone.",
    claims: ["bring-your-own-sandbox", "connected-placement"],
  },
  plugins: {
    title: "Set up plugins once.",
    subtitle: "Skills and MCP servers for your whole team, on every machine.",
    claims: ["agent-plugins", "team-plugin-sharing"],
  },
  workflow: {
    title: "Chat or terminal. Sidebar or tabs.",
    subtitle: "Every top agent in one composer, and a real terminal right beside it. Work the way you work.",
    claims: ["harness-coverage", "sessions-and-terminals", "agent-cli-access", "sidebar-or-tabs"],
  },
  closing: {
    text: "Open source. Local-first. No account needed.",
    claims: ["mit-platform", "desktop-local-mode"],
  },
} as const

export const homeBlocks = [home.hero, home.extend, home.benchmark, home.openSource, home.sandbox, home.plugins, home.workflow, home.closing]

/** The pill that downloads the Apple Silicon build directly; every other build is one click away on the download page. */
export const macDownload = downloads.find((download) => download.platform === "macos-arm64")!

export const commercialNavigation = [
  { label: "Pricing", href: routes.pricing, key: "pricing" },
  { label: "Download", href: routes.download, key: "download" },
  { label: "Compare", href: routes.compare, key: "compare" },
] as const

export const approvedMarketingActions = [marketingActions.download]
