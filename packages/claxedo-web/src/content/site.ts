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
  points: [
    { title: "Fast. Light. Yours to extend.", text: "Beats T3 Code and OpenCode on every core metric. Missing a feature? Prompt it into the app.", claims: ["core-metrics", "app-plugins-by-prompt"] },
    { title: "Open source. Live in 5 minutes.", text: "MIT licensed. Deploy it for your whole team on your own Cloudflare.", claims: ["mit-platform", "cloudflare-five-minutes"] },
    { title: "Bring your own sandbox.", text: "Any provider, any machine.", claims: ["bring-your-own-sandbox", "connected-placement"] },
    { title: "Set up plugins once.", text: "Skills and MCP servers for your whole team, on every machine.", claims: ["agent-plugins", "team-plugin-sharing"] },
    { title: "Chat or terminal.", text: "GUI or CLI. Sidebar or tabs. Work the way you work.", claims: ["sessions-and-terminals", "agent-cli-access", "sidebar-or-tabs"] },
  ],
  benchmark: {
    title: "Faster than T3 Code and OpenCode. On every core metric.",
    subtitle: "Starts faster. Switches faster. Uses less memory. Sits quiet when idle.",
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
  place: {
    title: "Any machine. Any sandbox.",
    subtitle: "Your laptop, your servers, your sandbox provider. Every session, from anywhere.",
    panels: [
      {
        title: "Run it where the work is.",
        text: "Your Mac, the studio machine, or any sandbox provider you choose. Pick the session up on desktop, browser or phone.",
        claims: ["connected-placement", "bring-your-own-sandbox"],
      },
      {
        title: "Every top agent, one composer.",
        text: "Claude Code, Codex, Cursor, OpenCode and Pi. Switch agent, model and effort in a click. Any ACP agent joins them.",
        claims: ["harness-coverage", "acp-client"],
      },
    ],
  },
  features: [
    {
      id: "prompt",
      title: "Missing a feature? Prompt it.",
      text: "Describe the page you want. Your agent builds it into the app.",
      claims: ["app-plugins-by-prompt"],
    },
    {
      id: "team",
      title: "Your cloud. Your team.",
      text: "Self-host Claxedo on your own Cloudflare in 5 minutes. MIT licensed.",
      href: `${github}/blob/dev/public-docs/user-deployed-cloudflare.md`,
      claims: ["cloudflare-five-minutes", "mit-platform"],
    },
    {
      id: "tools",
      title: "Your tools, everywhere.",
      text: "Skills and MCP servers, set up once for your whole team, on every machine.",
      claims: ["agent-plugins", "team-plugin-sharing"],
    },
  ],
  terminal: {
    title: "Chat or terminal. Your call.",
    text: "A clean chat for every agent, and a real terminal right beside it. Sidebar or tabs, however you work.",
    claims: ["sessions-and-terminals", "agent-cli-access", "sidebar-or-tabs"],
  },
  closing: {
    text: "Open source. Local-first. No account needed.",
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
