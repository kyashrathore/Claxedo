export type ComparisonStatus = "draft" | "current" | "expired"

export type ComparisonFact = {
  label: string
  value: string
  source: string
}

export type Competitor = {
  name: string
  slug: string
  category: "connected workspace" | "meta-harness" | "remote access" | "open agent" | "local orchestrator"
  priority: number
  intendedFor: string
  overlap: string
  boundary: string
  strength: string
  sources: readonly { label: string; href: string }[]
  facts: readonly ComparisonFact[]
  owner: string
  lastReviewed: string
  nextReview: string
  status: ComparisonStatus
}

export const competitors: readonly Competitor[] = [
  {
    name: "Matrix OS",
    slug: "matrix-os",
    category: "connected workspace",
    priority: 1,
    intendedFor: "Developers who want a persistent cloud coding computer with browser, terminal, and agent access.",
    overlap: "Both products connect coding-agent work across more than one client surface and document a self-host path.",
    boundary: "Matrix OS centers a persistent cloud computer. Claxedo centers a workspace around existing harnesses across local and connected placements.",
    strength: "Matrix OS has a clear VPS deployment path and a cohesive persistent-computer model.",
    sources: [
      { label: "Matrix OS documentation", href: "https://matrix-os.com/docs" },
      { label: "Matrix OS self-host guide", href: "https://matrix-os.com/docs/self-host" },
    ],
    facts: [
      { label: "Deployment", value: "Managed cloud or a documented Linux VPS self-host installation.", source: "https://matrix-os.com/docs/self-host" },
      { label: "Product layer", value: "A persistent cloud coding computer with files, settings, sessions, and agent history.", source: "https://matrix-os.com/docs" },
    ],
    owner: "Claxedo maintainers",
    lastReviewed: "2026-07-21",
    nextReview: "2026-08-21",
    status: "current",
  },
  {
    name: "Omnigent",
    slug: "omnigent",
    category: "meta-harness",
    priority: 2,
    intendedFor: "Teams composing, governing, and collaborating across built-in, CLI, and custom agents.",
    overlap: "Both products preserve recognizable coding harnesses and provide a shared surface around them.",
    boundary: "Omnigent presents a meta-harness and policy layer. Claxedo presents the complete developer workspace around sessions, terminals, WorkGraph, and review.",
    strength: "Omnigent has an explicit cross-agent policy model and supports several execution runners.",
    sources: [
      { label: "Omnigent product and architecture", href: "https://omnigent.ai/" },
      { label: "Omnigent documentation", href: "https://omnigent.ai/docs" },
    ],
    facts: [
      { label: "License", value: "The official site identifies Omnigent as Apache 2.0.", source: "https://omnigent.ai/" },
      { label: "Product layer", value: "A meta-harness connecting CLI and custom agents through runners, a server, policies, and shared clients.", source: "https://omnigent.ai/" },
    ],
    owner: "Claxedo maintainers",
    lastReviewed: "2026-07-21",
    nextReview: "2026-08-21",
    status: "current",
  },
  {
    name: "Paseo",
    slug: "paseo",
    category: "remote access",
    priority: 3,
    intendedFor: "Developers running multiple coding agents on their own machines from desktop, mobile, web, or CLI clients.",
    overlap: "Both products provide cross-device access to familiar coding-agent CLIs running on user-controlled machines.",
    boundary: "Paseo emphasizes a daemon and clients for remote agent access. Claxedo adds a broader workspace and durable WorkGraph coordination model.",
    strength: "Paseo offers a broad cross-device client set and a direct self-hosted daemon model.",
    sources: [
      { label: "Paseo source repository", href: "https://github.com/getpaseo/paseo" },
      { label: "Why Paseo", href: "https://paseo.sh/docs/why" },
    ],
    facts: [
      { label: "Execution", value: "Agent CLIs run on the user's machines behind a Paseo daemon.", source: "https://paseo.sh/docs/why" },
      { label: "Clients", value: "The project documents iOS, Android, desktop, web, and CLI access.", source: "https://github.com/getpaseo/paseo" },
    ],
    owner: "Claxedo maintainers",
    lastReviewed: "2026-07-21",
    nextReview: "2026-08-21",
    status: "current",
  },
  {
    name: "OpenHands",
    slug: "openhands",
    category: "open agent",
    priority: 4,
    intendedFor: "Developers and organizations adopting the OpenHands software agent locally, in its cloud, or through an enterprise deployment.",
    overlap: "Both products are model-aware developer tools with local and hosted paths and open-source foundations.",
    boundary: "OpenHands primarily supplies its own software-agent runtime. Claxedo is the workspace layer around multiple existing harnesses.",
    strength: "OpenHands provides a mature end-to-end agent experience across GUI, CLI, SDK, cloud, and enterprise offerings.",
    sources: [
      { label: "OpenHands pricing and deployment", href: "https://www.openhands.dev/pricing" },
      { label: "OpenHands documentation", href: "https://docs.openhands.dev/" },
    ],
    facts: [
      { label: "Open-source offer", value: "The official pricing page describes a free, local, MIT-licensed single-user product.", source: "https://www.openhands.dev/pricing" },
      { label: "Hosted offer", value: "OpenHands also offers cloud and enterprise SaaS or self-hosted options.", source: "https://www.openhands.dev/pricing" },
    ],
    owner: "Claxedo maintainers",
    lastReviewed: "2026-07-21",
    nextReview: "2026-08-21",
    status: "current",
  },
  {
    name: "T3 Code",
    slug: "t3-code",
    category: "local orchestrator",
    priority: 5,
    intendedFor: "Developers who want a fast, open-source desktop workspace for multiple coding-agent threads.",
    overlap: "Both products give coding agents a visual workspace and make parallel threads easier to supervise.",
    boundary: "T3 Code leads with a local coding-agent workspace. Claxedo's product model also includes connected clients, placement, and a framework layer.",
    strength: "T3 Code communicates a focused, fast multi-thread workspace with a straightforward open-source offer.",
    sources: [
      { label: "T3 Code product site", href: "https://t3.codes/" },
      { label: "T3 Code source", href: "https://github.com/pingdotgg/t3code" },
    ],
    facts: [
      { label: "Availability", value: "The official site describes T3 Code as free and open source.", source: "https://t3.codes/" },
      { label: "Product layer", value: "A desktop workspace showing multiple coding-agent threads.", source: "https://t3.codes/" },
    ],
    owner: "Claxedo maintainers",
    lastReviewed: "2026-07-21",
    nextReview: "2026-08-21",
    status: "current",
  },
  {
    name: "Hermes Agent",
    slug: "hermes-agent",
    category: "open agent",
    priority: 6,
    intendedFor: "People who want a self-improving personal agent with persistent memory, skills, tools, and multiple client channels.",
    overlap: "Both projects are open and support developer workflows, terminals, skills, and more than one access surface.",
    boundary: "Hermes is an agent and harness. Claxedo is the workspace around harnesses, including Hermes where an integration is supported.",
    strength: "Hermes has a distinctive learning loop and a broad personal-agent surface spanning CLI, desktop, messaging, tools, and memory.",
    sources: [
      { label: "Hermes Agent documentation", href: "https://hermes-agent.nousresearch.com/docs/" },
      { label: "Hermes Agent source", href: "https://github.com/NousResearch/hermes-agent" },
    ],
    facts: [
      { label: "Product layer", value: "A personal agent core exposed through CLI, desktop, messaging, and other clients.", source: "https://hermes-agent.nousresearch.com/docs/" },
      { label: "Provider support", value: "The official docs support Nous Portal, OpenRouter, OpenAI, and compatible endpoints.", source: "https://hermes-agent.nousresearch.com/docs/" },
    ],
    owner: "Claxedo maintainers",
    lastReviewed: "2026-07-21",
    nextReview: "2026-08-21",
    status: "current",
  },
]

export const trackedAlternatives = {
  "Model labs and closed products": ["Claude Code", "OpenAI Codex", "Google Jules", "Cursor", "Zed", "Devin", "Factory", "Amp", "Zencoder"],
  "Local orchestration": ["Conductor", "Orca", "Superset", "Emdash", "Supacode", "Jean", "cmux", "Sculptor", "Claude Squad"],
  "Cloud workspaces": ["Terminal Use", "boxes.dev", "Runtime", "Twill", "Coasts", "Superconductor", "Cursor Cloud Agents"],
  "Open runtimes and infrastructure": ["OpenCode", "Cline", "Goose", "Happy", "Omnara", "MidTerm", "codeg", "AgentsMesh", "Coder"],
  "Agent authoring frameworks": ["Flue", "Eve", "VibeKit"],
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
