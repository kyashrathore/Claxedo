export type ComparisonStatus = "draft" | "current" | "expired"

// One shared set of capability rows so every comparison is scannable side by side.
export type CapabilityKey =
  | "what"
  | "team"
  | "harnesses"
  | "interfaces"
  | "platforms"
  | "remote"
  | "ledger"
  | "selfHost"
  | "license"
  | "backing"
  | "pricing"

export const capabilityRows: readonly { key: CapabilityKey; label: string }[] = [
  { key: "what", label: "What it is" },
  { key: "team", label: "Team / multi-user" },
  { key: "harnesses", label: "Harnesses" },
  { key: "interfaces", label: "Interfaces" },
  { key: "platforms", label: "Platforms" },
  { key: "remote", label: "Remote access" },
  { key: "ledger", label: "Durable work ledger" },
  { key: "selfHost", label: "Self-host" },
  { key: "license", label: "License" },
  { key: "backing", label: "Backing" },
  { key: "pricing", label: "Pricing" },
]

// The at-a-glance feature grid on the index: features are rows, products are
// columns, each cell a yes / partial / no tick.
export type FeatureState = "yes" | "partial" | "no"
export type FeatureKey =
  | "team"
  | "openSource"
  | "selfHost"
  | "harnessNeutral"
  | "terminalFirstClass"
  | "splitPanes"
  | "layoutModes"
  | "managedProcesses"
  | "remote"
  | "workLedger"
  | "agentExtensions"
  | "channels"
  | "connections"
  | "documents"
  | "inAppBrowser"
  | "byokSandboxes"
  | "crossPlatform"
  | "nativeMobile"

export const featureRows: readonly { key: FeatureKey; label: string; description: string }[] = [
  { key: "team", label: "Multi-user / teams", description: "Real accounts and org scoping — teammates share workspaces, not one operator's machine." },
  { key: "openSource", label: "Open source", description: "OSI-approved license on the code you actually run — not source-available, not partial." },
  { key: "selfHost", label: "Self-hostable", description: "Run the whole product on infrastructure you control, including the control plane." },
  { key: "harnessNeutral", label: "Harness-neutral", description: "Claude Code, Codex, Gemini CLI, and more through one surface — no single-vendor lock." },
  { key: "terminalFirstClass", label: "Terminal coding agents, first class", description: "The real CLIs run as themselves — full terminal fidelity, not a chat wrapper imitating them." },
  { key: "splitPanes", label: "Split panes", description: "Chat, terminal, diffs, and files side by side in one workspace window." },
  { key: "layoutModes", label: "Configurable layout", description: "Switch the workspace between horizontal tabs and a vertical sidebar — your layout, not a fixed shell." },
  { key: "managedProcesses", label: "Managed processes", description: "Dev servers and watchers the workspace starts, restarts, and streams logs from — agents can read them too." },
  { key: "remote", label: "Remote access", description: "Reach the same live session from another device — browser or phone — not just start a new one." },
  { key: "workLedger", label: "Durable work ledger", description: "Work items, attempts, and approvals persist outside any single session — kill the app, the work state survives." },
  { key: "agentExtensions", label: "Agent extensions", description: "Author skills and MCP config once; synced into every harness's native format on every workspace." },
  { key: "channels", label: "Channels", description: "Drive sessions from Slack, Telegram, or WhatsApp — messages route into agent work." },
  { key: "connections", label: "Connections", description: "Link GitHub, Jira, or Linear once; features consume the account by capability without re-auth." },
  { key: "documents", label: "Document authoring", description: "First-class rich documents authored alongside the code — not just markdown preview." },
  { key: "inAppBrowser", label: "In-app browser", description: "A real browser inside the workspace — preview the app, and agents can drive it." },
  { key: "byokSandboxes", label: "BYOK sandboxes", description: "Bring your own sandbox provider and keys for cloud execution — not locked to the vendor's compute." },
  { key: "crossPlatform", label: "Cross-platform (not Mac-only)", description: "Desktop on macOS, Windows, and Linux." },
  { key: "nativeMobile", label: "Native mobile apps", description: "A real iOS/Android app, not a mobile web view." },
]

export const claxedoFeatures: Record<FeatureKey, FeatureState> = {
  team: "yes",
  openSource: "yes",
  selfHost: "yes",
  harnessNeutral: "yes",
  terminalFirstClass: "yes",
  splitPanes: "yes",
  layoutModes: "yes",
  managedProcesses: "yes",
  remote: "yes",
  workLedger: "yes",
  agentExtensions: "yes",
  channels: "yes",
  connections: "yes",
  documents: "yes",
  inAppBrowser: "yes",
  byokSandboxes: "yes",
  crossPlatform: "yes",
  nativeMobile: "no",
}

// Claxedo's constant column for the detailed per-page capability table.
export const claxedoCapabilities: Record<CapabilityKey, string> = {
  what: "Open-source workspace + framework you self-host",
  team: "Multi-user — accounts + org scoping (Clerk+Convex profile today)",
  harnesses: "Claude Code, Codex, Gemini CLI, OpenCode, + any CLI via ACP",
  interfaces: "Chat UI + first-class terminal",
  platforms: "Desktop (Mac/Win/Linux) + web + mobile web",
  remote: "Relay — reach the same session from any device",
  ledger: "WorkGraph — every task, attempt, and approval is a durable record that outlives sessions and restarts",
  selfHost: "Yes — single node, or Clerk+Convex on your own Cloudflare",
  license: "Open source",
  backing: "Independent · open source",
  pricing: "Free during beta; bring your own provider + sandbox",
}

export type Competitor = {
  name: string
  slug: string
  category: string
  priority: number
  tagline: string
  verdict: string
  features: Record<FeatureKey, FeatureState>
  // Footnote text for any "partial" feature, keyed by feature.
  featureNotes?: Partial<Record<FeatureKey, string>>
  capabilities: Record<CapabilityKey, string>
  genuineEdge: readonly string[]
  claxedoDiffers: readonly string[]
  chooseThem: string
  chooseClaxedo: string
  sources: readonly { label: string; href: string }[]
  owner: string
  lastReviewed: string
  nextReview: string
  status: ComparisonStatus
}

const REVIEW = { owner: "Claxedo maintainers", lastReviewed: "2026-07-22", nextReview: "2026-08-22", status: "current" } as const

export const competitors: readonly Competitor[] = [
  {
    name: "Paseo",
    slug: "paseo",
    category: "Remote-access daemon",
    priority: 1,
    tagline: "A self-hosted daemon for driving your own machine's coding agents from your phone, desktop, or web.",
    verdict:
      "The closest rival, and a genuine self-host peer — Paseo drives your own machine's agents from anywhere, with real native mobile apps. Claxedo differs on a permissive license, durable coordination, and being a multi-user platform rather than a single-operator daemon.",
    features: { team: "no", openSource: "yes", selfHost: "yes", harnessNeutral: "yes", terminalFirstClass: "yes", splitPanes: "no", layoutModes: "no", managedProcesses: "no", remote: "yes", workLedger: "no", agentExtensions: "no", channels: "no", connections: "no", documents: "no", inAppBrowser: "yes", byokSandboxes: "no", crossPlatform: "yes", nativeMobile: "yes" },
    capabilities: {
      what: "Self-hosted personal remote-access daemon",
      team: "None — no auth or accounts; a team means everyone runs their own daemon",
      harnesses: "39 via native CLI + ACP",
      interfaces: "Desktop, web, CLI; in-app terminal + browser",
      platforms: "Desktop (Mac/Win/Linux) + native iOS/Android + web",
      remote: "E2E-encrypted relay (a CF Worker + Durable Object) — optional + self-hostable",
      ledger: "None — heartbeats + cron schedules only",
      selfHost: "Yes — one daemon on your box (Docker/VPS)",
      license: "AGPL-3.0 (network copyleft)",
      backing: "Indie, no VC (GitHub Sponsors)",
      pricing: "Free, open source",
    },
    genuineEdge: [
      "Shipping native iOS + Android apps on both stores.",
      "A 39-agent published catalog plus a generic ACP path.",
      "Seriously documented end-to-end crypto (NaCl / Curve25519) for the relay.",
      "On-device voice, in-app browser, and per-worktree preview URLs.",
      "Genuinely no-vendor-lock-in self-host — no Paseo account or login exists.",
    ],
    claxedoDiffers: [
      "A multi-user platform your team signs into — Paseo has no accounts at all.",
      "Permissive open source vs AGPL-3.0's viral network copyleft (a procurement flag for products).",
      "WorkGraph, a durable task ledger — Paseo's only persistence is heartbeats + cron.",
      "A TypeScript framework/SDK to build on, not just a finished product.",
    ],
    chooseThem: "you want the best native mobile and the broadest agent catalog to remote-drive your own machine, and AGPL is fine for you.",
    chooseClaxedo: "you want a multi-user platform your team signs into, durable auditable coordination, and permissive open source.",
    sources: [
      { label: "Paseo", href: "https://paseo.sh" },
      { label: "Source (getpaseo/paseo)", href: "https://github.com/getpaseo/paseo" },
      { label: "Security model", href: "https://github.com/getpaseo/paseo/blob/main/SECURITY.md" },
    ],
    ...REVIEW,
  },
  {
    name: "Synara",
    slug: "synara",
    category: "Local desktop app",
    priority: 2,
    tagline: "A local-first desktop GUI that unifies the AI coding subscriptions you already pay for.",
    verdict:
      "Synara nails 'one window for the subscriptions you already pay for' — local-first and MIT. Claxedo takes the same wrap-your-harnesses idea and adds remote access, a durable ledger, and a multi-user platform you self-host.",
    features: { team: "no", openSource: "yes", selfHost: "no", harnessNeutral: "yes", terminalFirstClass: "yes", splitPanes: "yes", layoutModes: "no", managedProcesses: "no", remote: "no", workLedger: "no", agentExtensions: "no", channels: "no", connections: "no", documents: "no", inAppBrowser: "yes", byokSandboxes: "no", crossPlatform: "yes", nativeMobile: "no" },
    capabilities: {
      what: "Local-first desktop GUI (personal)",
      team: "None — a per-developer desktop app",
      harnesses: "Claude Code, Codex, OpenCode, Cursor, +5",
      interfaces: "Desktop GUI: chats, terminals, worktrees, diffs, browser previews",
      platforms: "Desktop (Mac/Win/Linux) only",
      remote: "None — strictly local, no cloud plane",
      ledger: "None",
      selfHost: "N/A — a local app with no backend to deploy",
      license: "MIT",
      backing: "Solo indie, no VC",
      pricing: "Free",
    },
    genuineEdge: [
      "The cleanest 'use what you already pay for' pitch in the category.",
      "Cross-provider thread hand-off with shared context — a second model resumes the same thread.",
      "MIT and genuinely local-first: no cloud holds your repos, chats, or history.",
      "Already ships on macOS, Windows, and Linux.",
    ],
    claxedoDiffers: [
      "A multi-user platform you self-host — Synara is a personal desktop app with no backend, remote, or team.",
      "Relay remote access — reach the same session from any device.",
      "WorkGraph durable coordination.",
      "A self-hostable framework, not just an app.",
    ],
    chooseThem: "you want a simple, free, local one-window GUI with cross-provider handoff.",
    chooseClaxedo: "you also need remote access, durable coordination, and a multi-user platform to self-host.",
    sources: [
      { label: "Synara", href: "https://www.trysynara.com" },
      { label: "Source (Emanuele-web04/synara)", href: "https://github.com/Emanuele-web04/synara" },
    ],
    ...REVIEW,
  },
  {
    name: "Conductor",
    slug: "conductor",
    category: "Local desktop app",
    priority: 3,
    tagline: "A polished macOS app for running parallel Claude Code, Codex, and Cursor agents in isolated worktrees.",
    verdict:
      "The slickest fan-out-and-review experience on a Mac, well-funded and shipping fast. Claxedo trades native polish for harness-neutral, cross-platform, remote, open source, and multi-user.",
    features: { team: "no", openSource: "no", selfHost: "no", harnessNeutral: "yes", terminalFirstClass: "no", splitPanes: "no", layoutModes: "no", managedProcesses: "no", remote: "no", workLedger: "no", agentExtensions: "no", channels: "no", connections: "no", documents: "no", inAppBrowser: "no", byokSandboxes: "no", crossPlatform: "no", nativeMobile: "no" },
    capabilities: {
      what: "Proprietary macOS parallel-agent app",
      team: "None — a per-developer Mac app",
      harnesses: "Claude Code, Codex, Cursor (no Gemini, no OpenCode)",
      interfaces: "Native Mac dashboard + review UI",
      platforms: "macOS only (Apple Silicon + Intel)",
      remote: "None — local Mac",
      ledger: "None — ephemeral local sessions + worktrees",
      selfHost: "No — closed, proprietary app",
      license: "Closed source",
      backing: "$22M Series A (Spark + Matrix), YC S24",
      pricing: "Free Mac app + paid Cloud",
    },
    genuineEdge: [
      "Best-in-class parallel-agent UX: dispatcher, at-a-glance status, isolated worktrees.",
      "Excellent review flow — diffs, inline comments synced to GitHub, one-click merge.",
      "Well-funded ($22M Series A) and shipping fast.",
      "Free on top of the subscriptions you already pay for.",
    ],
    claxedoDiffers: [
      "Harness-neutral — adds Gemini CLI, OpenCode, and any CLI via ACP (Conductor is Claude Code / Codex / Cursor only).",
      "Cross-platform vs macOS-only.",
      "Relay remote/connected access.",
      "WorkGraph durable coordination.",
      "Open source + framework + self-host, and multi-user, vs a closed per-developer app.",
    ],
    chooseThem: "you're Mac-only and want the slickest fan-out and review for Claude Code, Codex, and Cursor.",
    chooseClaxedo: "you want harness-neutral, cross-platform, remote-capable, open, and a platform your team self-hosts.",
    sources: [
      { label: "Conductor", href: "https://www.conductor.build" },
      { label: "Changelog", href: "https://www.conductor.build/changelog" },
      { label: "Series A", href: "https://www.conductor.build/blog/series-a" },
    ],
    ...REVIEW,
  },
  {
    name: "Superset",
    slug: "superset",
    category: "Local desktop app",
    priority: 4,
    tagline: "A macOS 'code editor for the AI agents era' built to orchestrate 100+ coding agents in parallel.",
    verdict:
      "Built to run an army of agents on a Mac, with the broadest agent list and an SDK. Claxedo is fully open, cross-platform, and a multi-user platform you self-host — where Superset gates remote and teams behind a paid hosted tier and ships under a restrictive license.",
    features: { team: "partial", openSource: "partial", selfHost: "partial", harnessNeutral: "yes", terminalFirstClass: "yes", splitPanes: "yes", layoutModes: "no", managedProcesses: "no", remote: "partial", workLedger: "no", agentExtensions: "no", channels: "no", connections: "no", documents: "no", inAppBrowser: "yes", byokSandboxes: "no", crossPlatform: "no", nativeMobile: "no" },
    featureNotes: {
      team: "Multi-user only via the paid, hosted remote tier.",
      openSource: "Elastic License 2.0 — source-available, not OSI-approved open source.",
      selfHost: "The app is source-available; remote workspaces are hosted-only.",
      remote: "Remote workspaces are a paid Pro beta.",
    },
    capabilities: {
      what: "Source-available macOS agent editor / orchestrator",
      team: "Only via the paid, hosted remote tier",
      harnesses: "11+ agents (agent-agnostic)",
      interfaces: "Mac app + CLI + SDK + MCP server; review + browser",
      platforms: "macOS (Windows/Linux untested); mobile 'coming soon'",
      remote: "Remote workspaces (Beta) — paid Pro, hosted",
      ledger: "None documented",
      selfHost: "Partial — source-available app; remote is hosted-only",
      license: "Elastic License 2.0 (source-available, not OSI-open)",
      backing: "YC (Spring 2026)",
      pricing: "Free (1 user) / Pro $15–20/user·mo / Enterprise",
    },
    genuineEdge: [
      "The broadest harness list — 11+ agents, truly agent-agnostic.",
      "10–100+ parallel agents with clean per-agent git-worktree isolation.",
      "A TypeScript SDK and an MCP server for extension.",
      "Editor handoff to VS Code, Cursor, JetBrains, and Xcode; a usable free local tier.",
    ],
    claxedoDiffers: [
      "Fully open source vs Elastic License 2.0 (source-available, restricts running it as a service).",
      "Relay as a free core primitive vs Superset's paid, hosted remote beta.",
      "WorkGraph durable coordination.",
      "Cross-platform vs effectively Mac-only.",
      "A multi-user platform you self-host vs teams gated behind a hosted tier.",
    ],
    chooseThem: "you're Mac-based and want to run many agents at once with a polished editor and the broadest agent list.",
    chooseClaxedo: "you want fully-open, cross-platform, remote-first, and teams you self-host — not a paid hosted tier.",
    sources: [
      { label: "Superset", href: "https://superset.sh" },
      { label: "Pricing", href: "https://superset.sh/pricing" },
      { label: "Source (superset-sh/superset)", href: "https://github.com/superset-sh/superset" },
    ],
    ...REVIEW,
  },
  {
    name: "T3 Code",
    slug: "t3-code",
    category: "Local desktop app",
    priority: 5,
    tagline: "A minimal desktop + local-web GUI over your agent CLIs from the T3 / ping.gg team — very early.",
    verdict:
      "A clean, minimal, MIT GUI over your agent CLIs with great one-click PR ergonomics — and very early. Claxedo is the broader, connected, durable, multi-user version with remote shipping today.",
    features: { team: "no", openSource: "yes", selfHost: "no", harnessNeutral: "yes", terminalFirstClass: "no", splitPanes: "no", layoutModes: "no", managedProcesses: "no", remote: "no", workLedger: "no", agentExtensions: "no", channels: "no", connections: "no", documents: "no", inAppBrowser: "no", byokSandboxes: "no", crossPlatform: "yes", nativeMobile: "no" },
    capabilities: {
      what: "Local desktop + web GUI (personal, early)",
      team: "None — a per-developer app",
      harnesses: "Codex, Claude Code, Cursor, OpenCode (Gemini planned)",
      interfaces: "Electron desktop + a local web GUI",
      platforms: "Desktop (Mac/Win/Arch) + local web; no mobile",
      remote: "Planned, not shipped",
      ledger: "None — project/thread + checkpointing",
      selfHost: "No — a local app; remote is planned",
      license: "MIT (not accepting contributions yet)",
      backing: "Ping Labs (YC W22); the tool itself isn't monetized",
      pricing: "Free",
    },
    genuineEdge: [
      "A clean, responsive Electron/web UI over messy terminal workflows.",
      "One-click commit, push, and PR with a per-turn diff viewer.",
      "Native git-worktree integration; MIT and bring-your-own-key.",
      "Strong distribution tailwind from the T3 / Theo audience.",
    ],
    claxedoDiffers: [
      "Remote access ships today — T3 Code's headless/remote mode is only planned.",
      "WorkGraph durable coordination.",
      "A framework + self-host control plane, and a multi-user platform.",
      "Gemini CLI shipped (T3 Code is Codex-first, Gemini planned).",
    ],
    chooseThem: "you want a minimal, free, local GUI over your agent CLIs.",
    chooseClaxedo: "you want remote access, durable coordination, and a multi-user platform to self-host.",
    sources: [
      { label: "Source (pingdotgg/t3code)", href: "https://github.com/pingdotgg/t3code" },
      { label: "Docs", href: "https://pingdotgg-t3code.mintlify.app/introduction" },
    ],
    ...REVIEW,
  },
  {
    name: "OpenCode",
    slug: "opencode",
    category: "Engine / harness",
    priority: 6,
    tagline: "The open-source, provider-agnostic terminal coding agent — and one of the harnesses Claxedo runs.",
    verdict:
      "OpenCode is a superb open terminal engine — and one of the harnesses Claxedo supports. Claxedo is the multi-user workspace around that class of engine: reach it from any device, coordinate durably, and self-host it for your team.",
    features: { team: "no", openSource: "yes", selfHost: "partial", harnessNeutral: "no", terminalFirstClass: "yes", splitPanes: "no", layoutModes: "no", managedProcesses: "no", remote: "no", workLedger: "no", agentExtensions: "no", channels: "no", connections: "no", documents: "no", inAppBrowser: "no", byokSandboxes: "no", crossPlatform: "yes", nativeMobile: "no" },
    featureNotes: { selfHost: "Self-hostable server, but local-only — no relay to reach it remotely." },
    capabilities: {
      what: "Open-source terminal coding agent (engine)",
      team: "None — local; /share is a public read-only link",
      harnesses: "Is the agent — 75+ model providers, bring your own key",
      interfaces: "TUI (terminal-first), desktop (beta), IDE extension",
      platforms: "Terminal (Mac/Win/Linux)",
      remote: "Local-only by default (binds 127.0.0.1)",
      ledger: "None — independent sessions",
      selfHost: "Partial — self-hostable server, but local-only",
      license: "MIT",
      backing: "Anomaly (ex-SST) · ~$1.1–1.6M seed (YC / Greylock)",
      pricing: "Free (MIT) + optional paid Zen model gateway",
    },
    genuineEdge: [
      "Truly provider-agnostic — 75+ providers, bring your own key, no model lock-in.",
      "A clean client/server design with an OpenAPI spec and a type-safe SDK.",
      "MIT and self-hostable, including a self-hostable share server.",
      "Terminal-native with LSP and MCP; a large, active community.",
    ],
    claxedoDiffers: [
      "OpenCode is the engine/harness; Claxedo is the multi-user workspace around it — and runs OpenCode inside it.",
      "Reach your sessions from any device via the relay (OpenCode binds to localhost).",
      "WorkGraph durable coordination across sessions (OpenCode sessions are independent).",
      "Team accounts and review surfaces (OpenCode's /share is a read-only link).",
    ],
    chooseThem: "you want a pure, open, provider-agnostic terminal agent.",
    chooseClaxedo: "you want a multi-user workspace around it (and other harnesses) with remote access and durable coordination — OpenCode still runs inside.",
    sources: [
      { label: "OpenCode", href: "https://opencode.ai" },
      { label: "Docs — Server", href: "https://opencode.ai/docs/server/" },
      { label: "Source (anomalyco/opencode)", href: "https://github.com/anomalyco/opencode" },
    ],
    ...REVIEW,
  },
]

// The wider landscape we track without publishing a maintained page for each.
export const trackedAlternatives = {
  "Model labs & closed products": ["Claude Code", "OpenAI Codex", "Cursor", "Google Jules", "Devin", "Factory", "Amp", "Zed"],
  "Local orchestrators": ["Orca", "Emdash", "cmux", "Sculptor", "Claude Squad", "Supacode"],
  "Cloud workspaces": ["Terminal Use", "boxes.dev", "Runtime", "Superconductor", "Cursor Cloud Agents"],
  "Open runtimes & infra": ["Cline", "Goose", "Happy", "Omnara", "Coder"],
} as const

export const publicComparisons = competitors.filter((competitor) => competitor.status !== "draft")
export const comparisonIsExpired = (competitor: Competitor, today = new Date().toISOString().slice(0, 10)) =>
  competitor.status === "expired" || competitor.nextReview < today
export const currentComparisonsFor = (records: readonly Competitor[], today = new Date().toISOString().slice(0, 10)) =>
  records.filter((competitor) => competitor.status === "current" && !comparisonIsExpired(competitor, today))
export const currentComparisons = currentComparisonsFor(publicComparisons)
export const expiredComparisonPaths = publicComparisons
  .filter((competitor) => comparisonIsExpired(competitor))
  .map((competitor) => `/compare/${competitor.slug}`)
