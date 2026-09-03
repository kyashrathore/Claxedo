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
  what: "Open-source workspace + control plane you self-host",
  team: "Multi-user — accounts + org scoping (Better Auth + D1)",
  harnesses: "Claude Code, Codex, Gemini CLI, OpenCode, + any CLI via ACP",
  interfaces: "Chat UI + first-class terminal",
  platforms: "Desktop (Mac/Win/Linux) + web + mobile web",
  remote: "Relay — reach the same session from any device",
  ledger: "WorkGraph — every task, attempt, and approval is a durable record that outlives sessions and restarts",
  selfHost: "Yes — single node, or Better Auth + D1 on your own Cloudflare",
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

const REVIEW = { owner: "Claxedo maintainers", lastReviewed: "2026-08-23", nextReview: "2026-09-23", status: "current" } as const

export const competitors: readonly Competitor[] = [
  {
    name: "Paseo",
    slug: "paseo",
    category: "Self-hosted agent orchestration",
    priority: 1,
    tagline: "Open-source agent orchestration across your own machines, desktop, web, CLI, and native mobile apps.",
    verdict:
      "Paseo is a genuine self-hosted peer with broad agent support, split workspaces, managed services, native mobile, and an optional team Hub. Claxedo differs most clearly on its permissive license, integrated organization scoping, and WorkGraph's explicit task, attempt, and approval records.",
    features: { team: "partial", openSource: "yes", selfHost: "yes", harnessNeutral: "yes", terminalFirstClass: "yes", splitPanes: "yes", layoutModes: "no", managedProcesses: "yes", remote: "yes", workLedger: "partial", agentExtensions: "partial", channels: "partial", connections: "yes", documents: "no", inAppBrowser: "yes", byokSandboxes: "no", crossPlatform: "yes", nativeMobile: "yes" },
    featureNotes: {
      team: "The optional self-hosted Hub adds organizations, accounts, credentials, and team access; the core daemon still has no forced Paseo login.",
      workLedger: "Workspaces, schedule runs, and Hub workflow runs persist, but Paseo does not document a general task-attempt-approval ledger.",
      agentExtensions: "Paseo installs shared orchestration skills and injects its tools through native interfaces or MCP; it does not document a general cross-harness extension-format synchronizer.",
      channels: "Paseo Hub supports Slack and Discord triggers and replies, but not Telegram or WhatsApp.",
    },
    capabilities: {
      what: "Open-source agent-orchestration daemon plus optional self-hosted Hub",
      team: "Optional Hub adds organizations, accounts, credentials, and team access; the core daemon has no forced login",
      harnesses: "Native adapters plus a curated ACP catalog — 39 agents listed at review time",
      interfaces: "Desktop, web, native mobile, and CLI; terminal, diff, browser, and review surfaces",
      platforms: "Desktop (Mac/Win/Linux) + native iOS/Android + web",
      remote: "Direct connections or an optional hosted/self-hosted end-to-end encrypted relay",
      ledger: "Durable workspaces, schedule history, and Hub workflow runs/steps; no general approval ledger documented",
      selfHost: "Yes — daemon, web UI, relay path, and optional Hub can run on infrastructure you control",
      license: "AGPL-3.0 (network copyleft)",
      backing: "Independent open-source project supported through GitHub Sponsors",
      pricing: "Free, open source",
    },
    genuineEdge: [
      "Native iOS and Android apps are available from both stores.",
      "A 39-agent catalog at review time, plus a generic path for other ACP agents.",
      "A documented end-to-end relay security model using NaCl and Curve25519.",
      "On-device voice, in-app browser, and per-worktree preview URLs.",
      "The core daemon requires no Paseo account; its web and remote paths can be self-hosted, while Hub accounts remain optional.",
    ],
    claxedoDiffers: [
      "Multi-user accounts and organization scoping are part of Claxedo's core platform rather than an optional Hub layer.",
      "Permissive open source rather than AGPL-3.0 network copyleft.",
      "WorkGraph records tasks, attempts, and approvals explicitly; Paseo persists workspaces, schedules, and workflow executions.",
      "A built-in organization-scoped control plane rather than an optional Hub layer.",
    ],
    chooseThem: "you want native mobile clients, a large published agent catalog, and a daemon-first way to operate your own machines, with an optional Hub for team workflows.",
    chooseClaxedo: "you want permissive open source, integrated multi-user organization scoping, portable agent setup, and explicit task-attempt-approval records.",
    sources: [
      { label: "Paseo", href: "https://paseo.sh" },
      { label: "Source (getpaseo/paseo)", href: "https://github.com/getpaseo/paseo" },
      { label: "Security model", href: "https://github.com/getpaseo/paseo/blob/main/SECURITY.md" },
      { label: "Providers", href: "https://paseo.sh/docs/providers" },
      { label: "Worktrees, scripts, and services", href: "https://paseo.sh/docs/worktrees" },
      { label: "Browser automation", href: "https://paseo.sh/docs/browser" },
      { label: "Hub concepts", href: "https://paseo.sh/docs/hub/concepts" },
      { label: "Self-hosting Hub", href: "https://paseo.sh/docs/hub/self-hosting" },
    ],
    ...REVIEW,
  },
  {
    name: "Synara",
    slug: "synara",
    category: "Local-first agent workspace",
    priority: 2,
    tagline: "A local-first workspace for nine coding-agent runtimes, durable tasks, review, automation, and self-hosted remote access.",
    verdict:
      "Synara is a capable MIT-licensed personal control plane: it now combines nine runtimes with durable tasks and goals, automations, managed worktrees, a shared browser, and authenticated self-hosted remote access. Claxedo differs on multi-user organization scoping, WorkGraph's explicit attempt and approval model, and portable agent setup across sandboxes.",
    features: { team: "no", openSource: "yes", selfHost: "yes", harnessNeutral: "yes", terminalFirstClass: "yes", splitPanes: "yes", layoutModes: "no", managedProcesses: "yes", remote: "yes", workLedger: "yes", agentExtensions: "no", channels: "no", connections: "no", documents: "no", inAppBrowser: "yes", byokSandboxes: "no", crossPlatform: "yes", nativeMobile: "no" },
    capabilities: {
      what: "Local-first personal desktop workspace and self-hostable web control plane",
      team: "Personal — no Synara account or organization model is required or documented",
      harnesses: "Claude Code, Codex, OpenCode, Cursor, Antigravity, Grok Build, Kilo Code, Pi, and Factory Droid",
      interfaces: "Desktop and self-hosted web UI with tasks, terminals, worktrees, diffs, browser, automations, and Studio",
      platforms: "Native desktop on Mac/Windows/Linux plus self-hosted web mode",
      remote: "Authenticated self-hosted server/web access over a LAN or Tailnet",
      ledger: "Durable tasks, transcripts and goals; approval and user-input gates; automation run history",
      selfHost: "Yes — run the open-source server and web application yourself; no Synara-hosted control plane is required",
      license: "MIT",
      backing: "Independent open-source project",
      pricing: "Free",
    },
    genuineEdge: [
      "Nine provider runtimes use the accounts, subscriptions, models, and permissions already configured on your machine.",
      "Cross-provider handoff keeps the same task environment and passes task context to the next provider.",
      "MIT and local-first: Synara workspace state is stored locally rather than in a Synara-hosted account; selected providers still receive the task data they need.",
      "Native releases for macOS, Windows, and Linux, plus an authenticated self-hosted web server.",
    ],
    claxedoDiffers: [
      "Multi-user accounts and organization scoping; Synara remains a personal workspace without a documented team identity model.",
      "A managed relay path in addition to self-hosting; Synara documents direct self-hosted web access over LAN or Tailnet.",
      "WorkGraph makes task attempts and approvals first-class records beyond Synara's durable tasks, goals, and automation history.",
      "Portable skills, MCP servers, plugins, and instructions that sync into supported sandboxes.",
    ],
    chooseThem: "you want a free personal workspace with nine local runtimes, provider handoff, durable tasks, automations, and direct self-hosted remote access.",
    chooseClaxedo: "you need organization-scoped multi-user workspaces, a managed relay option, explicit task-attempt-approval records, or portable setup across sandboxes.",
    sources: [
      { label: "Synara", href: "https://www.trysynara.com" },
      { label: "Source (Emanuele-web04/synara)", href: "https://github.com/Emanuele-web04/synara" },
      { label: "Documentation", href: "https://www.trysynara.com/docs" },
      { label: "Providers", href: "https://www.trysynara.com/docs/providers" },
      { label: "Remote access", href: "https://github.com/Emanuele-web04/synara/blob/main/REMOTE.md" },
      { label: "Thread goals", href: "https://www.trysynara.com/docs/features/thread-goals" },
      { label: "Automations", href: "https://www.trysynara.com/docs/workflows/automations" },
      { label: "Browser verification", href: "https://www.trysynara.com/docs/workflows/browser-verification" },
      { label: "External MCP", href: "https://www.trysynara.com/docs/workflows/external-mcp" },
    ],
    ...REVIEW,
  },
  {
    name: "Conductor",
    slug: "conductor",
    category: "Local and cloud agent workspace",
    priority: 3,
    tagline: "A macOS and hosted-cloud workspace for parallel Claude Code, Codex, Cursor, and OpenCode agents.",
    verdict:
      "Conductor now spans local Mac workspaces and a paid hosted Cloud with Multiplayer, four integrated harnesses, managed scripts, API access, persistent review state, and an experimental browser preview. Claxedo differs on open self-hosting, cross-platform desktop clients, generic ACP support, and WorkGraph's task-attempt-approval model.",
    features: { team: "yes", openSource: "no", selfHost: "no", harnessNeutral: "partial", terminalFirstClass: "yes", splitPanes: "no", layoutModes: "no", managedProcesses: "yes", remote: "yes", workLedger: "partial", agentExtensions: "partial", channels: "no", connections: "partial", documents: "no", inAppBrowser: "partial", byokSandboxes: "no", crossPlatform: "no", nativeMobile: "no" },
    featureNotes: {
      harnessNeutral: "Claude Code, Codex, Cursor, and OpenCode are integrated harnesses; Big Terminal can launch other CLIs, but Conductor does not document a generic integrated ACP or Gemini harness.",
      workLedger: "Workspaces, history, todos, checkpoints, and limited Codex goals persist, but Conductor does not document a cross-workspace task-attempt-approval ledger.",
      agentExtensions: "Claude Code, Codex, and OpenCode can reuse skills, while MCP and project configuration remain harness-specific rather than being converted into every native format.",
      connections: "Conductor integrates GitHub organizations and GitHub or Linear issues, but does not document a generic capability connection layer or Jira support.",
      inAppBrowser: "An experimental in-app browser preview ships with Agentation annotations; first-party docs do not show coding agents directly driving it.",
    },
    capabilities: {
      what: "macOS workspace plus hosted Cloud and Multiplayer platform for parallel coding agents",
      team: "Multiplayer and organization-scoped Teams/Enterprise plans with shared live workspaces",
      harnesses: "Claude Code, Codex, Cursor, and OpenCode; other CLIs can run through Big Terminal presets",
      interfaces: "Mac app, terminal, review/checks, experimental browser preview, Cloud collaboration, and HTTP API",
      platforms: "macOS client; hosted Amazon Linux cloud sandboxes; responsive mobile UI with a native app forthcoming",
      remote: "Cloud workspaces continue after the Mac app closes and can be shared live or driven through the API",
      ledger: "Restorable workspace history, todos, checkpoints, and limited Codex goals; no general attempts/approvals ledger documented",
      selfHost: "No self-hosted Cloud or control-plane option documented",
      license: "No public source repository or license documented",
      backing: "$22M Series A from Spark and Matrix; Y Combinator also participated",
      pricing: "Free local tier; Pro $50/mo; Teams $60/user/mo; Enterprise custom",
    },
    genuineEdge: [
      "Parallel isolated workspaces with dispatcher and at-a-glance activity state.",
      "An integrated review flow with diffs, line comments, GitHub review threads, checks, pull-request creation, and merge actions.",
      "$22M Series A financing from Spark and Matrix, with Y Combinator participating.",
      "A free local tier that uses your existing provider subscriptions or keys; Cloud and Multiplayer are paid-plan features.",
    ],
    claxedoDiffers: [
      "Integrated Gemini CLI and generic ACP support beyond Conductor's four integrated harnesses and arbitrary terminal presets.",
      "Native desktop clients on macOS, Windows, and Linux; Conductor's desktop client remains macOS-only.",
      "A self-hostable relay and control plane rather than Conductor's hosted Cloud and API.",
      "WorkGraph records tasks, attempts, and approvals beyond Conductor's workspace history, todos, checkpoints, and goals.",
      "An open-source, self-hosted multi-user control plane; Conductor does not document public source or a self-hosted control plane.",
    ],
    chooseThem: "you use a Mac or Conductor Cloud and want four integrated harnesses, live Multiplayer, managed scripts, and a GitHub-centered review flow.",
    chooseClaxedo: "you want generic ACP and Gemini support, cross-platform desktop clients, open source, a self-hosted control plane, or explicit task-attempt-approval records.",
    sources: [
      { label: "Conductor", href: "https://www.conductor.build" },
      { label: "Documentation", href: "https://www.conductor.build/docs" },
      { label: "Harnesses", href: "https://www.conductor.build/docs/reference/harnesses" },
      { label: "Pricing", href: "https://www.conductor.build/pricing" },
      { label: "Cloud and Multiplayer", href: "https://www.conductor.build/docs/cloud/faq" },
      { label: "Project scripts", href: "https://www.conductor.build/docs/reference/scripts" },
      { label: "Todos", href: "https://www.conductor.build/docs/reference/todos" },
      { label: "Browser preview", href: "https://www.conductor.build/changelog/0.62.0-repo-settings-browser-preview" },
      { label: "Platforms", href: "https://www.conductor.build/docs/installation" },
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
    tagline: "A source-available, macOS-primary terminal-first IDE built to orchestrate 100+ coding agents in parallel.",
    verdict:
      "Superset combines extensive agent support with worktrees, tasks, managed scripts, integrations, and an SDK. Its team and remote-workspace features remain part of a paid hosted tier, the project uses Elastic License 2.0, and macOS is its only fully supported desktop platform.",
    features: { team: "partial", openSource: "partial", selfHost: "partial", harnessNeutral: "yes", terminalFirstClass: "yes", splitPanes: "yes", layoutModes: "no", managedProcesses: "yes", remote: "partial", workLedger: "partial", agentExtensions: "no", channels: "yes", connections: "yes", documents: "no", inAppBrowser: "yes", byokSandboxes: "no", crossPlatform: "partial", nativeMobile: "no" },
    featureNotes: {
      team: "The free tier is for one user; paid Pro adds unlimited users and team collaboration.",
      openSource: "Elastic License 2.0 — source-available, not OSI-approved open source.",
      selfHost: "The source-available app and host server can run locally or headlessly, but organization and remote-device access use Superset's hosted relay/control plane; no supported self-hosted relay is documented.",
      remote: "Remote workspaces are a paid Pro beta delivered through Superset's hosted relay.",
      workLedger: "Tasks, pull-request tracking, and automations persist, but Superset does not document a task-attempt-approval graph.",
      crossPlatform: "macOS is supported, Linux x64 AppImage builds are experimental, and Windows is planned.",
    },
    capabilities: {
      what: "Source-available, terminal-first agentic IDE; macOS primary",
      team: "Free for one user; Pro adds unlimited users and team collaboration through organizations and host grants",
      harnesses: "14 named fully supported agents plus any CLI-based agent",
      interfaces: "Desktop IDE, CLI, TypeScript SDK, and MCP server with diff, editor, browser, and automation surfaces",
      platforms: "macOS supported; Linux x64 experimental; Windows planned; iOS coming",
      remote: "Paid Pro remote-workspaces beta through Superset's hosted relay",
      ledger: "Durable tasks, pull-request tracking, and automations; no general attempt/approval graph documented",
      selfHost: "The app and host server can run locally or headlessly; organization and remote-device access depend on Superset's hosted control plane",
      license: "Elastic License 2.0 (source-available, not OSI-open)",
      backing: "YC (Spring 2026)",
      pricing: "Free (1 user) / Pro $15–20/user·mo / Enterprise",
    },
    genuineEdge: [
      "Fourteen named fully supported agents plus any CLI-based agent.",
      "100+ parallel agents with per-agent git-worktree isolation.",
      "A TypeScript SDK and an MCP server for extension.",
      "Editor handoff to Cursor, VS Code, Zed, Windsurf, Antigravity, Sublime Text, and JetBrains; a free local tier.",
    ],
    claxedoDiffers: [
      "Permissive open source rather than Elastic License 2.0 source availability.",
      "A relay included as a core primitive rather than Superset's paid hosted remote-workspaces beta.",
      "WorkGraph records tasks, attempts, and approvals explicitly; Superset persists tasks, pull requests, and automations.",
      "Fully supported desktop clients on macOS, Windows, and Linux; Superset supports macOS, offers experimental Linux builds, and plans Windows.",
      "A self-hostable multi-user control plane; Superset's organization and remote-device paths depend on its hosted service.",
    ],
    chooseThem: "you are primarily Mac-based and want extensive CLI-agent support, 100+ isolated worktrees, managed scripts, tasks, integrations, and SDK/MCP extension points.",
    chooseClaxedo: "you want permissive open source, fully supported Mac/Windows/Linux clients, an included relay, a self-hosted multi-user control plane, and explicit task-attempt-approval records.",
    sources: [
      { label: "Superset", href: "https://superset.sh" },
      { label: "Pricing", href: "https://superset.sh/pricing" },
      { label: "Source (superset-sh/superset)", href: "https://github.com/superset-sh/superset" },
      { label: "README", href: "https://github.com/superset-sh/superset/blob/main/README.md" },
      { label: "Remote workspaces", href: "https://docs.superset.sh/remote-workspaces" },
      { label: "Setup and teardown scripts", href: "https://docs.superset.sh/setup-teardown-scripts" },
      { label: "Tasks", href: "https://docs.superset.sh/tasks" },
      { label: "Slack", href: "https://docs.superset.sh/use-with-slack" },
      { label: "Editor integrations", href: "https://docs.superset.sh/use-with-ide" },
    ],
    ...REVIEW,
  },
  {
    name: "T3 Code",
    slug: "t3-code",
    category: "Local desktop app",
    priority: 5,
    tagline: "A free, MIT agent-harness control plane with web, desktop, headless-server, and native mobile clients.",
    verdict:
      "T3 Code is a free, MIT, self-hostable control plane for five coding harnesses, with remote access, source-control workflows, a built-in terminal and preview, and native mobile clients. Claxedo differs on organization-scoped teams, generic ACP and Gemini support, WorkGraph, and portable agent setup across sandboxes.",
    features: { team: "no", openSource: "yes", selfHost: "yes", harnessNeutral: "yes", terminalFirstClass: "yes", splitPanes: "yes", layoutModes: "no", managedProcesses: "partial", remote: "yes", workLedger: "partial", agentExtensions: "no", channels: "no", connections: "yes", documents: "no", inAppBrowser: "yes", byokSandboxes: "no", crossPlatform: "yes", nativeMobile: "yes" },
    featureNotes: {
      managedProcesses: "Project scripts and server-owned terminal/provider processes are documented, but restart and log-management parity with a dedicated process manager is not.",
      workLedger: "Threads, turns, approvals, and checkpoints persist in an event-sourced store, but T3 Code does not document a cross-session task/work-item ledger.",
    },
    capabilities: {
      what: "MIT agent-harness control plane with a server runtime and web, Electron, and native mobile clients",
      team: "No shared organization or team workspace documented; remote authentication connects a user's devices and sessions",
      harnesses: "Claude Code, Codex, Cursor, Grok Build, and OpenCode",
      interfaces: "Web, Electron desktop, native iOS/Android, and a headless server with terminal, diff, files, and preview surfaces",
      platforms: "macOS, Windows, and Arch Linux desktop; web; native iOS and Android",
      remote: "Direct LAN/Tailscale HTTPS, headless `t3 serve`, SSH, hosted pairing, and the managed T3 Connect relay",
      ledger: "Persisted event-sourced threads, turns, approvals, and checkpoints; no cross-session task/work-item ledger documented",
      selfHost: "Yes — the core server and web client run on your infrastructure; hosted web and T3 Connect are optional",
      license: "MIT",
      backing: "Not stated in the listed first-party product sources",
      pricing: "Free; uses your existing agent subscriptions",
    },
    genuineEdge: [
      "Web, Electron, and native iOS/Android clients share one server runtime.",
      "One-button commit, push, and pull-request creation with per-turn checkpoint diffs.",
      "Native git-worktree integration, an MIT license, and bring-your-own agent subscriptions.",
      "Remote paths cover LAN, Tailscale, SSH, hosted pairing, and a managed relay.",
    ],
    claxedoDiffers: [
      "Organization-scoped multi-user workspaces; T3 Code documents device/session access rather than a shared team identity model.",
      "WorkGraph records tasks, attempts, and approvals beyond T3 Code's persisted threads, turns, approvals, and checkpoints.",
      "Portable skills, MCP servers, plugins, and instructions that sync into supported sandboxes.",
      "Generic ACP and Gemini CLI support beyond T3 Code's five named harnesses.",
    ],
    chooseThem: "you want a free MIT control plane for five agent CLIs with self-hosting, remote access, one-button source-control workflows, and native mobile clients.",
    chooseClaxedo: "you need organization-scoped teams, generic ACP or Gemini support, explicit task-attempt-approval records, or portable setup across sandboxes.",
    sources: [
      { label: "T3 Code", href: "https://t3.codes" },
      { label: "Source (pingdotgg/t3code)", href: "https://github.com/pingdotgg/t3code" },
      { label: "Installation", href: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md" },
      { label: "Remote access", href: "https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md" },
      { label: "Source control", href: "https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md" },
      { label: "Architecture", href: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md" },
    ],
    ...REVIEW,
  },
  {
    name: "OpenCode",
    slug: "opencode",
    category: "Engine / harness",
    priority: 6,
    tagline: "An open-source, provider-agnostic coding agent with terminal, web, desktop, and IDE clients — and one of the harnesses Claxedo runs.",
    verdict:
      "OpenCode is an MIT coding-agent engine with 75+ model providers, terminal, web, desktop, and IDE clients, plus network-accessible self-hosted server modes. Claxedo is the multi-harness workspace around that class of engine, adding a managed relay, organization-scoped collaboration, and WorkGraph coordination.",
    features: { team: "partial", openSource: "yes", selfHost: "partial", harnessNeutral: "no", terminalFirstClass: "yes", splitPanes: "no", layoutModes: "no", managedProcesses: "no", remote: "yes", workLedger: "no", agentExtensions: "no", channels: "no", connections: "no", documents: "no", inAppBrowser: "no", byokSandboxes: "no", crossPlatform: "yes", nativeMobile: "no" },
    featureNotes: {
      team: "Enterprise adds central configuration and SSO, and Zen workspaces have roles; no shared live multi-user coding workspace is documented, while `/share` publishes conversation history by link.",
      selfHost: "The core server and web client can be self-run; public sharing uses OpenCode's hosted service, while first-party enterprise material is not yet consistent about a supported self-hosted share/control-plane path.",
      remote: "`opencode web --hostname` can expose a password-protected web/server instance on a network; it binds to localhost by default and includes no managed relay.",
    },
    capabilities: {
      what: "Open-source coding agent with terminal, web, desktop, and IDE clients",
      team: "Enterprise central configuration and SSO plus Zen workspace roles; `/share` publishes conversation history, but no shared live multi-user workspace is documented",
      harnesses: "Is the agent — 75+ model providers, bring your own key",
      interfaces: "Terminal TUI, web client, desktop app, and IDE extensions",
      platforms: "Terminal and desktop on macOS, Windows, and Linux",
      remote: "Binds to localhost by default; authenticated network web/server access is configurable, with no managed relay",
      ledger: "None — independent sessions",
      selfHost: "Core server and web client can be self-run; public sharing uses OpenCode's hosted service and enterprise self-hosting remains inconsistently documented",
      license: "MIT",
      backing: "Anomaly (formerly SST); funding details are not stated in the listed first-party sources",
      pricing: "Free MIT core; optional Zen pay-as-you-go, Go at $5 for the first month then $10/month, and Enterprise per-seat pricing",
    },
    genuineEdge: [
      "Seventy-five-plus model providers, local-model support, and bring-your-own keys.",
      "A client/server design with an OpenAPI specification and type-safe SDK.",
      "An MIT-licensed core server and web client that can run on your own machine or infrastructure.",
      "Terminal-native LSP and MCP integration plus skills, plugins, and custom tools.",
    ],
    claxedoDiffers: [
      "OpenCode is the engine/harness; Claxedo is the multi-user workspace around it — and runs OpenCode inside it.",
      "A managed relay for device access; OpenCode requires you to expose and secure its web/server endpoint yourself.",
      "WorkGraph records tasks, attempts, and approvals across sessions; OpenCode sessions remain independent.",
      "Organization-scoped live workspaces and review surfaces; OpenCode documents central enterprise policy, Zen roles, and public conversation links rather than a shared live coding workspace.",
    ],
    chooseThem: "you want an MIT, provider-agnostic coding agent with terminal, web, desktop, and IDE clients that you can expose on your own network.",
    chooseClaxedo: "you want a multi-harness, organization-scoped workspace with a managed relay and explicit task-attempt-approval coordination — while still running OpenCode inside it.",
    sources: [
      { label: "OpenCode", href: "https://opencode.ai" },
      { label: "Docs — Server", href: "https://opencode.ai/docs/server/" },
      { label: "Docs — Web", href: "https://opencode.ai/docs/web/" },
      { label: "Docs — Providers", href: "https://opencode.ai/docs/providers/" },
      { label: "Docs — Share", href: "https://opencode.ai/docs/share/" },
      { label: "Docs — Enterprise", href: "https://opencode.ai/docs/enterprise/" },
      { label: "Docs — SDK", href: "https://opencode.ai/docs/sdk/" },
      { label: "Downloads", href: "https://opencode.ai/download" },
      { label: "OpenCode Go", href: "https://opencode.ai/docs/go/" },
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
