export interface ArchStage {
  id: "clients" | "control" | "connection" | "execution"
  index: string
  title: string
  blurb: string
  note?: string
  packages: { name: string; repo?: boolean }[]
}

export const archEdges = [
  {
    key: "in",
    label: "Ways in",
    pkg: "@claxedo/channels",
    blurb: "Start and drive sessions from where you already talk.",
    items: ["GitHub", "Slack", "Telegram", "Discord"],
  },
  {
    key: "connect",
    label: "Connect",
    pkg: "@claxedo/connections",
    blurb: "Link accounts once; features use them by capability.",
    items: ["GitHub", "Notion", "Google", "Atlassian"],
  },
]

export const archModes = [
  {
    id: "local",
    label: "Local",
    caption:
      "The workspace runtime is embedded — the control plane calls it over loopback. No relay, nothing leaves your machine.",
  },
  {
    id: "cloud",
    label: "Cloud",
    caption:
      "For a remote or hosted runtime, the browser reaches it through the secure relay — the control plane mints a short-lived token.",
  },
  {
    id: "shared",
    label: "Shared",
    caption:
      "Sign in and expose your local workspace through the relay, so you can pick it up from another device — claxedo up.",
  },
]

export const archStages: ArchStage[] = [
  {
    id: "clients",
    index: "01",
    title: "Clients",
    blurb: "Desktop, browser, and CLI reach one control plane over the Claxedo protocol — never the runtime directly.",
    packages: [{ name: "claxedo-app", repo: true }],
  },
  {
    id: "control",
    index: "02",
    title: "Control plane",
    blurb: "Owns auth, routing, credentials, and policy; picks direct-or-relay. Deploy to Claxedo Cloud or your own Cloudflare.",
    packages: [
      { name: "claxedo-server", repo: true },
      { name: "@claxedo/workgraph" },
      { name: "@claxedo/agent-extensions" },
      { name: "@claxedo/wakes" },
      { name: "@claxedo/connections" },
      { name: "@claxedo/channels" },
    ],
  },
  {
    id: "connection",
    index: "03",
    title: "Connection",
    blurb: "A secure relay tunnels traffic across the trust boundary — code runs in the workspace, never in the Worker.",
    packages: [{ name: "@claxedo/workspace-relay" }, { name: "@claxedo/workspace-relay-protocol" }],
  },
  {
    id: "execution",
    index: "04",
    title: "Workspace execution",
    blurb: "One runtime per workspace runs your chosen harness — sessions, terminals, files, and diffs — on your machine, server, or a sandbox.",
    note: "Inside, three packages translate any harness into one event model — a session runtime, an SDK facade, and an event normalizer.",
    packages: [
      { name: "@claxedo/workspace-runtime" },
      { name: "@claxedo/agent-sdk-runtime" },
      { name: "@claxedo/agent-event-runtime" },
      { name: "@claxedo/sandbox-manager" },
      { name: "@claxedo/mcp" },
    ],
  },
]
