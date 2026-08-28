import { marketingActions, routes } from "./routes"

export const site = {
  name: "Claxedo",
  category: "The coding agent workspace",
  headline: "Your coding agents, finally in one place.",
  description:
    "Run every coding agent in one fast workspace. Bring any sandbox, sync every tool, and move between chat and terminal without changing how you work.",
  hero: {
    eyebrow: "One workspace for every coding agent",
    headline: "Your coding agents, finally in one place.",
    lead:
      "Open Claude Code, Codex, OpenCode, or any agent CLI in the same fast workspace. Bring any sandbox. Your skills, MCP servers, plugins, and credentials follow automatically.",
    proof: ["Performance-first", "Any sandbox provider", "Chat + terminal"],
    costNote: "Cloudflare Workers Paid starts at $5/month; usage and connected services are separate.",
  },
  focusSections: [
    {
      id: "performance",
      index: "01",
      eyebrow: "Fast",
      headline: "Faster than T3 Code, measured.",
      copy: "Same machine. Packaged builds. Identical frozen sessions. Claxedo won 36 of 40 published measurements.",
    },
    {
      id: "sandboxes",
      index: "02",
      eyebrow: "Bring your own sandbox",
      headline: "Your provider. Your keys. One setup.",
      copy: "Choose the provider you already run. Claxedo syncs skills, MCP servers, plugins, and scoped credentials before the workspace starts.",
    },
    {
      id: "chat",
      index: "03",
      eyebrow: "Chat GUI",
      headline: "Every harness gets a first-class chat.",
      copy: "Switch Claude, Codex, Cursor, Pi, or OpenCode—and choose the model and effort—without moving your work to another app.",
    },
    {
      id: "terminal",
      index: "04",
      eyebrow: "Terminal GUI",
      headline: "Or run the CLIs side by side.",
      copy: "Claude and Codex stay real terminal processes inside the same split workbench. Use the sidebar or horizontal tabs without losing either session.",
    },
    {
      id: "control-plane",
      index: "05",
      eyebrow: "$5 Cloudflare control plane",
      headline: "Deploy once. Reach every workspace.",
      copy: "Host the control plane on a Cloudflare Worker, sign in, enroll this machine, and connect from another device. Remote control is built for the whole team. Multiplayer is next.",
    },
  ],
  freeBeta: "Free during beta",
  localMode: "Local mode works without an account",
  product: {
    name: "Claxedo",
    destination: routes.home,
  },
  clients: {
    web: { name: "Claxedo Web", destination: "https://app.claxedo.com" },
    desktop: { name: "Claxedo Desktop", destination: routes.download },
  },
  hostedDescriptor: "Claxedo Cloud",
} as const

export const commercialNavigation = [
  { label: "Pricing", href: routes.pricing, key: "pricing" },
  { label: "Download", href: routes.download, key: "download" },
  { label: "Compare", href: routes.compare, key: "compare" },
] as const

export const approvedMarketingActions = [marketingActions.download]
