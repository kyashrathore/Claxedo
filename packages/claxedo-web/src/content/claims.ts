export type ClaimStatus = "verified" | "withheld"

export type Claim = {
  id: string
  publicWording: string
  owner: string
  evidence: readonly string[]
  status: ClaimStatus
  verifiedAt?: string
  reason?: string
}

export const claims = [
  {
    id: "free-beta",
    publicWording: "Claxedo is free during beta.",
    owner: "Claxedo product",
    evidence: [
      "docs/plans/2026-07-28-002-claxedo-launch-remaining.md",
      "packages/claxedo-server/src/billing/entitlement.ts",
    ],
    status: "verified",
    verifiedAt: "2026-07-21",
  },
  {
    id: "desktop-local-mode",
    publicWording: "Start locally without a Claxedo account.",
    owner: "Claxedo Desktop",
    evidence: ["packages/claxedo-desktop/package.json", "packages/claxedo-app/src/platform/auth/auth-session.ts"],
    status: "verified",
    verifiedAt: "2026-07-21",
  },
  {
    id: "sessions-and-terminals",
    publicWording: "Chat sessions and terminals are equally first-class parts of the workspace.",
    owner: "Claxedo App",
    evidence: [
      "packages/claxedo-app/src/app/workbench/rail/onboarding-empty-state.tsx",
      "packages/claxedo-app/src/features/terminal/actions/terminal-actions.ts",
    ],
    status: "verified",
    verifiedAt: "2026-07-21",
  },
  {
    id: "agent-cli-access",
    publicWording: "Use supported coding agents through Claxedo's chat UI, or run any installed agent CLI in a terminal.",
    owner: "Claxedo App",
    evidence: [
      "packages/agent-sdk-runtime/package.json",
      "packages/claxedo-app/src/features/session/conversation/conversation-chat-client.ts",
      "packages/claxedo-app/src/features/terminal/actions/terminal-actions.ts",
    ],
    status: "verified",
    verifiedAt: "2026-07-21",
  },
  {
    id: "connected-placement",
    publicWording: "Start work on your machine and reopen the same workspace from the desktop app or browser.",
    owner: "Claxedo runtime",
    evidence: [
      "packages/claxedo-app/src/platform/runtime/cloud/workspace-runtime-store.ts",
      "packages/claxedo-server/src/routes/remote-access.test.ts",
      "packages/workspace-relay/src/composition.test.ts",
      "packages/workspace-runtime/src/sdk-transport-parity.test.ts",
    ],
    status: "verified",
    verifiedAt: "2026-07-21",
  },
  {
    id: "agent-extensions",
    publicWording: "Agent Extensions package skills, instructions, MCP servers, plugins, hooks, and supporting files as portable agent setup.",
    owner: "Agent Extensions",
    evidence: [
      "packages/agent-extensions/src/index.ts",
      "packages/agent-extensions/src/materialize.ts",
      "packages/agent-extensions/src/materializers/mcp.ts",
      "packages/agent-extensions/src/materializers/skills.ts",
      "packages/agent-extensions/src/materializers/cursor.ts",
    ],
    status: "verified",
    verifiedAt: "2026-07-21",
  },
  {
    id: "acp-client",
    publicWording: "Claxedo can present ACP-compatible agents in its structured chat UI.",
    owner: "Agent runtime",
    evidence: [
      "packages/agent-sdk-runtime/src/adapters.ts",
      "packages/agent-event-runtime/src/harnesses/acp/event-translator.ts",
      "packages/agent-event-runtime/src/harnesses/acp/golden-compat.test.ts",
    ],
    status: "verified",
    verifiedAt: "2026-07-21",
  },
  {
    id: "opencode-lineage",
    publicWording: "Claxedo is built on the OpenCode engine.",
    owner: "Claxedo maintainers",
    evidence: ["LICENSE", "packages/opencode/package.json"],
    status: "verified",
    verifiedAt: "2026-07-21",
  },
  {
    id: "public-source",
    publicWording: "Claxedo's clients, server, relay, protocol, and workspace runtime are developed in the public repository.",
    owner: "Claxedo maintainers",
    evidence: [
      "packages/claxedo-app/package.json",
      "packages/claxedo-desktop/package.json",
      "packages/claxedo-server/package.json",
      "packages/workspace-relay/package.json",
      "packages/workspace-relay-protocol/package.json",
      "packages/workspace-runtime/package.json",
    ],
    status: "verified",
    verifiedAt: "2026-07-21",
  },
  {
    id: "mit-platform",
    publicWording: "Claxedo's clients, control plane, relay, workspace runtime, agent runtimes, extension system, and sandbox integration packages are MIT licensed.",
    owner: "Claxedo maintainers",
    evidence: [
      "LICENSE",
      "packages/claxedo-app/package.json",
      "packages/claxedo-desktop/package.json",
      "packages/claxedo-server/package.json",
      "packages/workspace-relay/package.json",
      "packages/workspace-relay-protocol/package.json",
      "packages/workspace-runtime/package.json",
      "packages/agent-sdk-runtime/package.json",
      "packages/agent-event-runtime/package.json",
      "packages/agent-extensions/package.json",
      "packages/sandbox-manager/package.json",
    ],
    status: "verified",
    verifiedAt: "2026-07-22",
  },
  {
    id: "agent-runtime-study",
    publicWording: "Across 92,390 measured intervals in one local corpus, the median time before a coding agent needed a full machine again was 10.8 seconds.",
    owner: "Agent Runtime Stats",
    evidence: [
      "packages/claxedo-web/src/content/2026-08-09-runtime-study.json",
      "packages/claxedo-web/src/pages/how-often-do-coding-agents-need-a-full-machine.astro",
    ],
    status: "verified",
    verifiedAt: "2026-08-09",
  },
  {
    id: "hosted-source-parity",
    publicWording: "The hosted and self-hosted products run the same complete source composition.",
    owner: "Claxedo operations",
    evidence: [],
    status: "withheld",
    reason: "Requires deployed-composition evidence from the production owner.",
  },
  {
    id: "setup-continuity",
    publicWording: "Credentials and setup automatically follow users across machines and cloud workspaces.",
    owner: "Claxedo connections",
    evidence: [],
    status: "withheld",
    reason: "Requires a security-reviewed cross-machine acceptance artifact.",
  },
] as const satisfies readonly Claim[]

export const publishableClaims = claims.filter(
  (claim): claim is (typeof claims)[number] & { status: "verified"; verifiedAt: string } =>
    claim.status === "verified" && claim.evidence.length > 0 && Boolean(claim.verifiedAt),
)

export const claim = (id: string) => publishableClaims.find((item) => item.id === id)

export const requireClaim = (id: string) => {
  const item = claim(id)
  if (!item) throw new Error(`Public page requires a verified claim: ${id}`)
  return item
}
