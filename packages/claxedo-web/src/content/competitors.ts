export type ComparisonStatus = "draft" | "current" | "expired"

// One shared set of capability rows so every comparison is scannable side by side.
export type CapabilityKey =
  | "what"
  | "team"
  | "harnesses"
  | "interfaces"
  | "platforms"
  | "remote"
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
  | "agentPlugins"
  | "channels"
  | "connections"
  | "documents"
  | "inAppBrowser"
  | "byokSandboxes"
  | "crossPlatform"
  | "nativeMobile"

export const featureRows: readonly { key: FeatureKey; label: string; description: string }[] = [
  { key: "team", label: "Multi-user / teams", description: "Real accounts and organizations, so teammates share workspaces." },
  { key: "openSource", label: "Open source", description: "An OSI-approved license on the code you run." },
  { key: "selfHost", label: "Self-hostable", description: "Run the whole product, control plane included, on your own infrastructure." },
  { key: "harnessNeutral", label: "Harness-neutral", description: "Claude Code, Codex, Cursor, OpenCode, Pi and more in one app, with no single-vendor lock-in." },
  { key: "terminalFirstClass", label: "Terminal coding agents, first class", description: "The real agent CLIs run as themselves, in a full terminal." },
  { key: "splitPanes", label: "Split panes", description: "Chat, terminal, diffs and files side by side in one window." },
  { key: "layoutModes", label: "Configurable layout", description: "Keep sessions in a sidebar or open them as tabs." },
  { key: "managedProcesses", label: "Managed processes", description: "Dev servers the workspace starts, restarts and logs, and agents can read." },
  { key: "remote", label: "Remote access", description: "Pick up the same live session from a browser or phone." },
  { key: "agentPlugins", label: "Agent Plugins", description: "Turn on standard plugins once and every harness gets them." },
  { key: "channels", label: "Channels", description: "Start agent work from Slack, Telegram or WhatsApp." },
  { key: "connections", label: "Connections", description: "Link GitHub, Jira or Linear once and every feature can use it." },
  { key: "documents", label: "Document authoring", description: "Rich documents written alongside the code, beyond a Markdown preview." },
  { key: "inAppBrowser", label: "In-app browser", description: "A real browser in the workspace that agents can drive." },
  { key: "byokSandboxes", label: "BYOK sandboxes", description: "Bring your own sandbox provider for cloud execution." },
  { key: "crossPlatform", label: "Cross-platform (not Mac-only)", description: "Desktop apps for macOS, Windows and Linux." },
  { key: "nativeMobile", label: "Native mobile apps", description: "A real iOS or Android app, not a mobile web view." },
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
  agentPlugins: "yes",
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
  what: "Open-source workspace for every coding agent, with a control plane you can host",
  team: "Multi-user, with accounts and organizations",
  harnesses: "Claude Code, Codex, Cursor, OpenCode and Pi, plus any ACP agent",
  interfaces: "Chat and a real terminal, side by side",
  platforms: "Desktop on Mac, Windows and Linux, plus web and mobile web",
  remote: "Pick up the same session from any device",
  selfHost: "Yes, on your own machine or your own Cloudflare",
  license: "MIT",
  backing: "Independent, open source",
  pricing: "Free. Bring your own model provider and sandbox.",
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

const REVIEW = { owner: "Claxedo maintainers", lastReviewed: "2026-09-29", nextReview: "2026-10-29", status: "current" } as const

export const competitors: readonly Competitor[] = [
  {
    name: "Paseo",
    slug: "paseo",
    category: "Self-hosted agent orchestration",
    priority: 1,
    tagline: "Open-source agent orchestration across your own machines, desktop, web, CLI, and native mobile apps.",
    verdict:
      "Paseo is a genuine self-hosted peer with broad agent support, split workspaces, managed services, native mobile, and an optional team Hub. Claxedo differs most clearly on organization scoping built into its core platform.",
    features: { team: "partial", openSource: "yes", selfHost: "yes", harnessNeutral: "yes", terminalFirstClass: "yes", splitPanes: "yes", layoutModes: "no", managedProcesses: "yes", remote: "yes", agentPlugins: "partial", channels: "partial", connections: "partial", documents: "no", inAppBrowser: "yes", byokSandboxes: "no", crossPlatform: "yes", nativeMobile: "yes" },
    featureNotes: {
      team: "The optional self-hosted Hub adds organizations, accounts, credentials, and team access; the core daemon still has no forced Paseo login.",
      agentPlugins: "Paseo installs shared orchestration skills and injects its tools through native interfaces or MCP; it does not document Agent Plugins support. Its own TypeScript plugins extend the app and daemon, not the harnesses.",
      connections: "Paseo Hub links GitHub, Slack, and Discord once per organization and grants GitHub access per workflow step; there is no Jira or Linear connection.",
      channels: "Paseo Hub supports Slack and Discord triggers and replies, but not Telegram or WhatsApp.",
    },
    capabilities: {
      what: "Open-source agent-orchestration daemon plus an optional Hub, self-hosted or managed",
      team: "Optional Hub adds organizations, accounts, credentials, and team access; the core daemon has no forced login",
      harnesses: "Native adapters plus a curated ACP catalog of 39 agents at review time",
      interfaces: "Desktop, web, native mobile, and CLI; terminal, diff, browser, and review surfaces",
      platforms: "Desktop (Mac/Win/Linux) + native iOS/Android + web",
      remote: "Direct connections or an optional hosted/self-hosted end-to-end encrypted relay",
      selfHost: "Yes; the daemon, web UI, relay path, and optional Hub can run on infrastructure you control",
      license: "Apache-2.0, including the Hub and relay",
      backing: "Independent project by one developer, funded by GitHub Sponsors, company sponsors, and hosted Hub plans",
      pricing: "Free, open source; hosted Hub has a Free plan and Pro at $15 per seat a month",
    },
    genuineEdge: [
      "Native iOS and Android apps are available from both stores.",
      "A 39-agent catalog at review time, plus a generic path for other ACP agents.",
      "A documented end-to-end relay security model using NaCl and Curve25519.",
      "On-device voice, in-app browser, and per-worktree preview URLs.",
      "The core daemon requires no Paseo account; its web and remote paths can be self-hosted, while Hub accounts remain optional.",
    ],
    claxedoDiffers: [
      "Multi-user accounts and organization scoping are built into Claxedo's core platform rather than an optional Hub layer.",
      "Connections to GitHub, Jira, and Linear that every feature can use, not just Hub workflows.",
    ],
    chooseThem: "you want native mobile clients, a large published agent catalog, and a daemon-first way to operate your own machines, with an optional Hub for team workflows.",
    chooseClaxedo: "you want integrated multi-user organization scoping and portable agent setup.",
    sources: [
      { label: "Paseo", href: "https://paseo.sh" },
      { label: "Source (getpaseo/paseo)", href: "https://github.com/getpaseo/paseo" },
      { label: "License (Apache-2.0)", href: "https://github.com/getpaseo/paseo/blob/main/LICENSE" },
      { label: "Security model", href: "https://github.com/getpaseo/paseo/blob/main/SECURITY.md" },
      { label: "Download", href: "https://paseo.sh/download" },
      { label: "Supported agents", href: "https://paseo.sh/agents" },
      { label: "Providers", href: "https://paseo.sh/docs/providers" },
      { label: "Connectivity", href: "https://paseo.sh/docs/connectivity" },
      { label: "Worktrees, scripts, and services", href: "https://paseo.sh/docs/worktrees" },
      { label: "Browser automation", href: "https://paseo.sh/docs/browser" },
      { label: "Paseo Hub (plans)", href: "https://paseo.sh/hub" },
      { label: "Hub concepts", href: "https://paseo.sh/docs/hub/concepts" },
      { label: "Hub triggers", href: "https://paseo.sh/docs/hub/triggers" },
      { label: "Self-hosting Hub", href: "https://paseo.sh/docs/hub/self-hosting" },
      { label: "iOS app", href: "https://apps.apple.com/app/paseo-pocket-engineer/id6758887924" },
      { label: "Android app", href: "https://play.google.com/store/apps/details?id=sh.paseo" },
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
      "Synara is a capable MIT-licensed personal control plane: it now combines nine runtimes with durable tasks and goals, automations, managed worktrees, a shared browser, and authenticated self-hosted remote access. Claxedo differs on multi-user organization scoping and portable agent setup across sandboxes.",
    features: { team: "no", openSource: "yes", selfHost: "yes", harnessNeutral: "yes", terminalFirstClass: "partial", splitPanes: "yes", layoutModes: "no", managedProcesses: "partial", remote: "yes", agentPlugins: "no", channels: "no", connections: "no", documents: "no", inAppBrowser: "yes", byokSandboxes: "no", crossPlatform: "yes", nativeMobile: "no" },
    featureNotes: {
      terminalFirstClass: "Runtimes run through ACP, the Codex app-server, or the Claude Agent SDK inside Synara's own transcript; its built-in terminals run whatever you type.",
      managedProcesses: "The Environment panel starts, shows, and stops tracked dev servers; restarts and agent access to server logs are not documented.",
    },
    capabilities: {
      what: "Local-first personal desktop workspace and self-hostable web control plane",
      team: "Personal; no Synara account or organization model is required or documented",
      harnesses: "Claude Code, Codex, OpenCode, Cursor, Antigravity, Grok Build, Devin CLI, Pi, and Factory Droid",
      interfaces: "Desktop and self-hosted web UI with tasks, terminals, worktrees, diffs, browser, automations, and Studio",
      platforms: "Native desktop on Mac/Windows/Linux plus self-hosted web mode",
      remote: "Authenticated self-hosted web server over LAN, Tailnet, or your own HTTPS reverse proxy",
      selfHost: "Yes; run the open-source server and web application yourself; no Synara-hosted control plane is required",
      license: "MIT",
      backing: "Independent open-source project funded by sponsors and donations",
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
      "A managed relay path in addition to self-hosting; Synara documents direct self-hosted web access over LAN, Tailnet, or your own HTTPS reverse proxy.",
      "Portable skills, MCP servers, plugins, and instructions that sync into supported sandboxes.",
    ],
    chooseThem: "you want a free personal workspace with nine local runtimes, provider handoff, durable tasks, automations, and direct self-hosted remote access.",
    chooseClaxedo: "you need organization-scoped multi-user workspaces, a managed relay option, or portable setup across sandboxes.",
    sources: [
      { label: "Synara", href: "https://www.trysynara.com" },
      { label: "Source (Emanuele-web04/synara)", href: "https://github.com/Emanuele-web04/synara" },
      { label: "License (MIT)", href: "https://github.com/Emanuele-web04/synara/blob/main/LICENSE" },
      { label: "Releases", href: "https://github.com/Emanuele-web04/synara/releases" },
      { label: "Changelog", href: "https://www.trysynara.com/changelog" },
      { label: "Documentation", href: "https://www.trysynara.com/docs" },
      { label: "Providers", href: "https://www.trysynara.com/docs/providers" },
      { label: "Devin CLI provider", href: "https://www.trysynara.com/docs/providers/devin" },
      { label: "Headless server", href: "https://www.trysynara.com/docs/workflows/headless-server" },
      { label: "Remote access", href: "https://github.com/Emanuele-web04/synara/blob/main/REMOTE.md" },
      { label: "Organize and navigate", href: "https://www.trysynara.com/docs/features/organize" },
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
      "Conductor now spans local Mac workspaces and a paid hosted Cloud with Multiplayer, four integrated harnesses, managed scripts, API access, persistent review state, and an experimental browser preview. Claxedo differs on open self-hosting, cross-platform desktop clients, and Pi plus any ACP agent as integrated harnesses.",
    features: { team: "yes", openSource: "no", selfHost: "no", harnessNeutral: "partial", terminalFirstClass: "partial", splitPanes: "partial", layoutModes: "no", managedProcesses: "yes", remote: "yes", agentPlugins: "partial", channels: "no", connections: "partial", documents: "no", inAppBrowser: "partial", byokSandboxes: "no", crossPlatform: "no", nativeMobile: "no" },
    featureNotes: {
      harnessNeutral: "Claude Code, Codex, Cursor, and OpenCode are integrated harnesses; Big Terminal presets can launch Amp, Pi, Copilot, and Gemini, but Conductor does not document ACP support.",
      terminalFirstClass: "Integrated harnesses run in Conductor's chat UI; the real CLIs run in terminal tabs or the experimental Big Terminal Mode.",
      splitPanes: "A fixed layout with chat in the center and Changes and terminal tabs in a right panel; no splits you arrange yourself.",
      agentPlugins: "Claude Code, Codex, and OpenCode can reuse skills, while MCP and project configuration remain harness-specific.",
      connections: "Conductor integrates GitHub, GitHub or Linear issues, and Slack through MCP settings, but does not document a generic capability connection layer or Jira support.",
      inAppBrowser: "An experimental in-app browser preview ships with Agentation annotations; first-party docs do not show coding agents directly driving it.",
    },
    capabilities: {
      what: "macOS workspace plus hosted Cloud and Multiplayer platform for parallel coding agents",
      team: "Multiplayer and organization-scoped Teams/Enterprise plans with shared live workspaces",
      harnesses: "Claude Code, Codex, Cursor, and OpenCode; other CLIs can run through Big Terminal presets",
      interfaces: "Mac app, terminal, review/checks, experimental browser preview, Cloud collaboration, and HTTP API",
      platforms: "macOS client; hosted Amazon Linux cloud sandboxes; iOS app coming soon",
      remote: "Cloud workspaces continue after the Mac app closes and can be shared live or driven through the API",
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
      "Pi as a built-in harness plus any ACP agent in the chat UI, beyond Conductor's four integrated harnesses and terminal presets.",
      "Native desktop clients on macOS, Windows, and Linux; Conductor's desktop client remains macOS-only.",
      "A self-hostable relay and control plane rather than Conductor's hosted Cloud and API.",
      "An open-source, self-hosted multi-user control plane; Conductor does not document public source or a self-hosted control plane.",
    ],
    chooseThem: "you use a Mac or Conductor Cloud and want four integrated harnesses, live Multiplayer, managed scripts, and a GitHub-centered review flow.",
    chooseClaxedo: "you want Pi and any ACP agent as integrated harnesses, cross-platform desktop clients, open source, or a self-hosted control plane.",
    sources: [
      { label: "Conductor", href: "https://www.conductor.build" },
      { label: "Documentation", href: "https://www.conductor.build/docs" },
      { label: "Harnesses", href: "https://www.conductor.build/docs/reference/harnesses" },
      { label: "Big Terminal Mode", href: "https://www.conductor.build/docs/reference/big-terminal-mode" },
      { label: "Pricing", href: "https://www.conductor.build/pricing" },
      { label: "Conductor Cloud", href: "https://www.conductor.build/docs/cloud" },
      { label: "Multiplayer", href: "https://www.conductor.build/docs/cloud/collaboration" },
      { label: "Cloud FAQ", href: "https://www.conductor.build/docs/cloud/faq" },
      { label: "Conductor API", href: "https://www.conductor.build/docs/api" },
      { label: "Project scripts", href: "https://www.conductor.build/docs/reference/scripts" },
      { label: "Review and merge", href: "https://www.conductor.build/docs/guides/review-and-merge" },
      { label: "Agent modes and skills", href: "https://www.conductor.build/docs/concepts/agent-modes" },
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
      "Superset combines extensive agent support with worktrees, tasks, managed scripts, integrations, and an SDK. Its team, remote-access, and mobile features remain part of a paid hosted tier, the project uses Elastic License 2.0, and macOS is its only fully supported desktop platform.",
    features: { team: "partial", openSource: "partial", selfHost: "partial", harnessNeutral: "yes", terminalFirstClass: "yes", splitPanes: "yes", layoutModes: "no", managedProcesses: "yes", remote: "partial", agentPlugins: "no", channels: "yes", connections: "yes", documents: "no", inAppBrowser: "yes", byokSandboxes: "no", crossPlatform: "partial", nativeMobile: "yes" },
    featureNotes: {
      team: "The free tier is for one user; paid Pro adds unlimited users and team collaboration.",
      openSource: "Elastic License 2.0: source-available, not OSI-approved open source.",
      selfHost: "The source-available app and host server can run locally or headlessly, but organization and remote-device access use Superset's hosted relay/control plane; no supported self-hosted relay is documented.",
      remote: "Remote access is a paid Pro feature through Superset's hosted relay, reachable from the desktop app, CLI, or iPhone app.",
      crossPlatform: "macOS is supported, Linux x64 AppImage builds are experimental, and Windows is planned.",
    },
    capabilities: {
      what: "Source-available, terminal-first agentic IDE; macOS primary",
      team: "Free for one user; Pro adds unlimited users and team collaboration through organizations and host grants",
      harnesses: "21 named fully supported agents plus any CLI agent",
      interfaces: "Desktop IDE, iPhone app, CLI, TypeScript SDK, and MCP server with diff, editor, browser, and automation surfaces",
      platforms: "macOS supported; Linux x64 experimental; Windows planned; iPhone app (Pro)",
      remote: "Paid Pro remote access through Superset's hosted relay, from desktop, CLI, or iPhone",
      selfHost: "The app and host server can run locally or headlessly; organization and remote-device access depend on Superset's hosted control plane",
      license: "Elastic License 2.0 (source-available, not OSI-open)",
      backing: "Venture-funded ($11M raised); founded by three ex-YC CTOs",
      pricing: "Free (1 user) / Pro $15–20/user·mo / Enterprise",
    },
    genuineEdge: [
      "Twenty-one named fully supported agents plus any CLI agent.",
      "100+ parallel agents with per-agent git-worktree isolation.",
      "A TypeScript SDK and an MCP server for extension.",
      "Editor handoff to Cursor, VS Code, Zed, Windsurf, Antigravity, Sublime Text, and JetBrains; a free local tier.",
    ],
    claxedoDiffers: [
      "Permissive open source rather than Elastic License 2.0 source availability.",
      "A relay included as a core primitive rather than Superset's paid hosted remote access.",
      "Fully supported desktop clients on macOS, Windows, and Linux; Superset supports macOS, offers experimental Linux builds, and plans Windows.",
      "A self-hostable multi-user control plane; Superset's organization and remote-device paths depend on its hosted service.",
    ],
    chooseThem: "you are primarily Mac-based and want extensive CLI-agent support, 100+ isolated worktrees, managed scripts, tasks, integrations, and SDK/MCP extension points.",
    chooseClaxedo: "you want permissive open source, fully supported Mac/Windows/Linux clients, an included relay, and a self-hosted multi-user control plane.",
    sources: [
      { label: "Superset", href: "https://superset.sh" },
      { label: "Pricing", href: "https://superset.sh/pricing" },
      { label: "About", href: "https://superset.sh/about" },
      { label: "Superset for iPhone", href: "https://superset.sh/mobile" },
      { label: "App Store listing", href: "https://apps.apple.com/us/app/id6788926383" },
      { label: "Source (superset-sh/superset)", href: "https://github.com/superset-sh/superset" },
      { label: "README", href: "https://github.com/superset-sh/superset/blob/main/README.md" },
      { label: "License (ELv2)", href: "https://github.com/superset-sh/superset/blob/main/LICENSE.md" },
      { label: "FAQ", href: "https://docs.superset.sh/faq" },
      { label: "AI agents", href: "https://docs.superset.sh/agent-integration" },
      { label: "Remote access", href: "https://docs.superset.sh/remote-access" },
      { label: "Setup and teardown scripts", href: "https://docs.superset.sh/setup-teardown-scripts" },
      { label: "Tasks", href: "https://docs.superset.sh/tasks" },
      { label: "Slack", href: "https://docs.superset.sh/use-with-slack" },
      { label: "Editor integrations", href: "https://docs.superset.sh/use-with-ide" },
      { label: "In-app browser", href: "https://docs.superset.sh/browser" },
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
      "T3 Code is a free, MIT, self-hostable control plane for six coding harnesses, with remote access, source-control workflows, a built-in terminal and preview, and native mobile clients. Claxedo differs on organization-scoped teams, Pi and any ACP agent as harnesses, and portable agent setup across sandboxes.",
    features: { team: "no", openSource: "yes", selfHost: "yes", harnessNeutral: "yes", terminalFirstClass: "partial", splitPanes: "yes", layoutModes: "no", managedProcesses: "partial", remote: "yes", agentPlugins: "no", channels: "no", connections: "yes", documents: "no", inAppBrowser: "yes", byokSandboxes: "no", crossPlatform: "yes", nativeMobile: "yes" },
    featureNotes: {
      terminalFirstClass: "Agents run through their SDK, app-server, or ACP protocols in a chat UI; a built-in terminal can run any CLI.",
      managedProcesses: "Project scripts and server-owned terminal/provider processes are documented, but restart and log-management parity with a dedicated process manager is not.",
    },
    capabilities: {
      what: "MIT agent-harness control plane with a server runtime and web, Electron, and native mobile clients",
      team: "No shared organization or team workspace documented; remote authentication connects a user's devices and sessions",
      harnesses: "Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity",
      interfaces: "Web, Electron desktop, native iOS/Android, and a headless server with terminal, diff, files, and preview surfaces",
      platforms: "macOS, Windows, and Linux (AppImage, .deb, AUR) desktop, plus WSL backends; web; native iOS and Android",
      remote: "Direct LAN/Tailscale HTTPS, headless `t3 serve`, SSH, hosted pairing, and the managed T3 Connect relay",
      selfHost: "Yes; the core server and web client run on your infrastructure, and hosted web and T3 Connect are optional",
      license: "MIT",
      backing: "T3 Tools Inc. (MIT copyright holder); repository under the pingdotgg organization",
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
      "Portable skills, MCP servers, plugins, and instructions that sync into supported sandboxes.",
      "Pi as a built-in harness and any ACP agent, beyond T3 Code's six named harnesses.",
    ],
    chooseThem: "you want a free MIT control plane for six agent harnesses with self-hosting, remote access, one-button source-control workflows, and native mobile clients.",
    chooseClaxedo: "you need organization-scoped teams, Pi or any ACP agent as a harness, or portable setup across sandboxes.",
    sources: [
      { label: "T3 Code", href: "https://t3.codes" },
      { label: "Source (pingdotgg/t3code)", href: "https://github.com/pingdotgg/t3code" },
      { label: "License", href: "https://github.com/pingdotgg/t3code/blob/main/LICENSE" },
      { label: "Releases", href: "https://github.com/pingdotgg/t3code/releases" },
      { label: "Installation", href: "https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md" },
      { label: "Remote access", href: "https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md" },
      { label: "Source control", href: "https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md" },
      { label: "Threads and worktrees", href: "https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md" },
      { label: "Preview browser", href: "https://github.com/pingdotgg/t3code/blob/main/docs/user/browser-import.md" },
      { label: "Architecture", href: "https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md" },
      { label: "iOS app", href: "https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824" },
      { label: "Android app", href: "https://play.google.com/store/apps/details?id=com.t3tools.t3code" },
    ],
    ...REVIEW,
  },
  {
    name: "OpenCode",
    slug: "opencode",
    category: "Engine / harness",
    priority: 6,
    tagline: "An open-source, provider-agnostic coding agent with terminal, web, desktop, and IDE clients, and one of the harnesses Claxedo runs.",
    verdict:
      "OpenCode is an MIT coding-agent engine with 75+ model providers, terminal, web, desktop, and IDE clients, plus network-accessible self-hosted server modes. Claxedo is the multi-harness workspace around that class of engine, adding a managed relay and organization-scoped collaboration.",
    features: { team: "partial", openSource: "yes", selfHost: "partial", harnessNeutral: "no", terminalFirstClass: "yes", splitPanes: "no", layoutModes: "no", managedProcesses: "no", remote: "yes", agentPlugins: "no", channels: "no", connections: "no", documents: "no", inAppBrowser: "no", byokSandboxes: "no", crossPlatform: "yes", nativeMobile: "no" },
    featureNotes: {
      team: "Enterprise adds central config and SSO; the Console adds workspace roles, member budgets, and team policies. No shared live multi-user coding workspace is documented, and V2 does not support session sharing yet.",
      selfHost: "The core server and web client can be self-run; V1 public sharing uses OpenCode's hosted service, while first-party enterprise material is not yet consistent about a supported self-hosted share/control-plane path.",
      remote: "`opencode web --hostname` can expose a password-protected web/server instance on a network; it binds to localhost by default and includes no managed relay.",
    },
    capabilities: {
      what: "Open-source coding agent with terminal, web, desktop, and IDE clients",
      team: "Enterprise SSO and central config plus Console workspace roles, budgets, and policies; no shared live multi-user workspace is documented",
      harnesses: "It is the agent: 75+ model providers, bring your own key",
      interfaces: "Terminal TUI, web client, desktop app, and IDE extensions",
      platforms: "Terminal and desktop on macOS, Windows, and Linux",
      remote: "Binds to localhost by default; authenticated network web/server access is configurable, with no managed relay",
      selfHost: "Core server and web client can be self-run, and V2 ships Docker images; V1 public sharing uses OpenCode's hosted service and enterprise self-hosting remains inconsistently documented",
      license: "MIT",
      backing: "Anomaly (formerly SST); funding details are not stated in the listed first-party sources",
      pricing: "Free MIT core; optional Zen pay-as-you-go, Go at $10/month or Go Plus at $40/month, and Enterprise per-seat pricing",
    },
    genuineEdge: [
      "Seventy-five-plus model providers, local-model support, and bring-your-own keys.",
      "A client/server design with an OpenAPI specification and type-safe SDK.",
      "An MIT-licensed core server and web client that can run on your own machine or infrastructure.",
      "MCP servers, skills, plugins, and custom tools, with LSP diagnostics in V1.",
    ],
    claxedoDiffers: [
      "OpenCode is the engine; Claxedo is the multi-user workspace around it, and runs OpenCode inside it.",
      "A managed relay for device access; OpenCode requires you to expose and secure its web/server endpoint yourself.",
      "Organization-scoped live workspaces and review surfaces; OpenCode documents central enterprise policy, Console roles and budgets, and V1 conversation links rather than a shared live coding workspace.",
    ],
    chooseThem: "you want an MIT, provider-agnostic coding agent with terminal, web, desktop, and IDE clients that you can expose on your own network.",
    chooseClaxedo: "you want a multi-harness, organization-scoped workspace with a managed relay, while still running OpenCode inside it.",
    sources: [
      { label: "OpenCode", href: "https://opencode.ai" },
      { label: "Downloads", href: "https://opencode.ai/download" },
      { label: "Docs (V2)", href: "https://opencode.ai/v2/docs" },
      { label: "Migrate from V1", href: "https://opencode.ai/v2/docs/migrate-v1/" },
      { label: "Sharing (V2)", href: "https://opencode.ai/v2/docs/sharing/" },
      { label: "Console", href: "https://opencode.ai/v2/docs/console/" },
      { label: "Server", href: "https://opencode.ai/docs/server/" },
      { label: "Web", href: "https://opencode.ai/docs/web/" },
      { label: "Providers", href: "https://opencode.ai/docs/providers/" },
      { label: "Share (V1)", href: "https://opencode.ai/docs/share/" },
      { label: "Enterprise", href: "https://opencode.ai/docs/enterprise/" },
      { label: "SDK", href: "https://opencode.ai/docs/sdk/" },
      { label: "OpenCode Go", href: "https://opencode.ai/go" },
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
