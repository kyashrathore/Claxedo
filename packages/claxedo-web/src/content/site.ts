import { benchmark, downloads, github } from "../config"
import { routes } from "./routes"

export const site = {
  name: "Claxedo",
  category: "The coding agent workspace",
  description:
    "One open-source app for Claude Code, Codex, Cursor, OpenCode, Pi and any ACP agent. Set up skills, plugins and MCP servers once, and run sessions on your laptop, your other machines or a cloud sandbox.",
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
    title: "Own your coding agent app.",
    subtitle: "Open source. Host it yourself. Every agent, no lock-in.",
    claims: ["mit-platform", "cloudflare-five-minutes", "harness-coverage", "free"],
  },
  speed: {
    title: "Fast. Light. Efficient.",
    subtitle: "Faster than T3 Code and OpenCode on every core metric.",
    claims: ["core-metrics"],
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
  prompt: {
    title: "Missing a feature? Prompt it.",
    subtitle: "Ask your agent for it. It lands right in the app.",
    ask: "Add a Standup page that sums up yesterday's sessions.",
    cards: ["The ask", "Added to the menu", "The page"],
    claims: ["app-plugins-by-prompt"],
  },
  openSource: {
    title: "Open source. Live in 5 minutes.",
    subtitle: "MIT licensed. Deploy it for your whole team on your own Cloudflare.",
    href: `${github}/blob/dev/public-docs/user-deployed-cloudflare.md`,
    claims: ["mit-platform", "cloudflare-five-minutes"],
  },
  sandbox: {
    title: "Bring your own sandbox.",
    subtitle: "Any machine, any sandbox. Pick up every session on desktop, browser or phone.",
    claims: ["bring-your-own-sandbox", "connected-placement"],
  },
  plugins: {
    title: "Set up plugins once.",
    subtitle: "Add your team's plugin repo once. Everyone turns on what they need, in every agent, on every machine.",
    cards: ["Add to the catalog", "Each teammate chooses", "Every agent, every machine"],
    claims: ["agent-plugins", "team-plugin-sharing", "agent-plugins-follow-you"],
  },
  workflow: {
    title: "Chat or terminal. Sidebar or tabs.",
    subtitle: "Chat with any agent, or open a real terminal right beside it. Work the way you work.",
    cards: ["Chat or terminal", "Sidebar or tabs"],
    claims: ["harness-coverage", "sessions-and-terminals", "agent-cli-access", "sidebar-or-tabs"],
  },
  closing: {
    text: "Open source. Local‑first. No account needed.",
    claims: ["mit-platform", "desktop-local-mode"],
  },
} as const

export const homeBlocks = [home.hero, home.speed, home.benchmark, home.prompt, home.openSource, home.sandbox, home.plugins, home.workflow, home.closing]

/** The pill that downloads the Apple Silicon build directly; every other build is one click away on the download page. */
export const macDownload = downloads.find((download) => download.platform === "macos-arm64")!

export const pricing = {
  title: "Free.",
  subtitle: "Every agent and every feature, with no subscription. Bring your own models and machines.",
  price: "$0",
  plan: "Claxedo",
  included: [
    "Claxedo Desktop, local-first with no account",
    "Claxedo Cloud",
    "MIT-licensed app, control plane and runtime",
    "macOS, Windows and Linux",
  ],
  bring: [
    { title: "Models", text: "Your own subscriptions or API keys. No credits to buy." },
    { title: "Compute", text: "Your laptop, your servers or your own sandbox provider." },
    { title: "Your deployment", text: "Self-host it and it's yours to run." },
  ],
  claims: ["free", "desktop-local-mode", "mit-platform", "bring-your-own-sandbox"],
} as const

export const downloadPage = {
  title: "Download Claxedo.",
  subtitle: "Works locally with no account. Sign in when you want your machines, sandboxes and team.",
  stepsTitle: "Start local. Grow when you need to.",
  steps: [
    { title: "Start local", text: "Open a folder and run sessions or terminals. No account needed." },
    { title: "Connect when you want", text: "Sign in to reach your machines, sandboxes and teammates from desktop, browser or phone." },
    { title: "Keep your providers", text: "Use your own model accounts and compute. No credits to buy." },
  ],
  claims: ["desktop-local-mode", "connected-placement"],
} as const

export const comparePage = {
  title: "The whole field, side by side.",
  lead: "Most tools here are single-operator apps or closed clouds. Claxedo is the open-source, multi-user workspace for every agent, and your team can host it. Every claim links to a first-party source.",
} as const

export const commercialNavigation = [
  { label: "Pricing", href: routes.pricing, key: "pricing" },
  { label: "Download", href: routes.download, key: "download" },
  { label: "Compare", href: routes.compare, key: "compare" },
] as const

