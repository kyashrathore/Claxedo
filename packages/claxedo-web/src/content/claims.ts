export type ClaimStatus = "verified" | "withheld"

export type Claim = {
  id: string
  publicWording: string
  owner: string
  evidence: readonly string[]
  status: ClaimStatus
  verifiedAt?: string
  reason?: string
  note?: string
}

export const claims = [
  {
    id: "free-beta",
    publicWording: "Claxedo is free during beta.",
    owner: "Claxedo product",
    evidence: ["packages/claxedo-server/src/billing/entitlement.ts"],
    status: "verified",
    verifiedAt: "2026-09-28",
  },
  {
    id: "desktop-local-mode",
    publicWording: "Start locally without a Claxedo account.",
    owner: "Claxedo Desktop",
    evidence: [
      "packages/claxedo-desktop/src/main/index.ts",
      "packages/claxedo-desktop/src/main/account/lazy-account.ts",
      "packages/claxedo-app/src/server/capabilities.ts",
    ],
    status: "verified",
    verifiedAt: "2026-09-28",
  },
  {
    id: "sessions-and-terminals",
    publicWording: "Chat sessions and terminals are equally first-class parts of the workspace.",
    owner: "Claxedo App",
    evidence: [
      "packages/claxedo-app/src/session/index.ts",
      "packages/claxedo-app/src/terminal/launchers.ts",
    ],
    status: "verified",
    verifiedAt: "2026-09-28",
  },
  {
    id: "sidebar-or-tabs",
    publicWording: "Sessions sit in a pinned sidebar, or, with the sidebar unpinned, as tabs in the workbench header.",
    owner: "Claxedo App",
    evidence: [
      "packages/claxedo-app/src/rail/view/compact-switcher.tsx",
      "packages/claxedo-app/src/shell/view/app-shell.tsx",
      "packages/claxedo-app/e2e/flows/12-workbench-shell.spec.ts",
    ],
    status: "verified",
    verifiedAt: "2026-09-29",
    note: "Owner ruling 2026-09-29.",
  },
  {
    id: "cloudflare-five-minutes",
    publicWording: "Deploy Claxedo for your whole team on your own Cloudflare in 5 minutes.",
    owner: "Claxedo server",
    evidence: [
      "public-docs/user-deployed-cloudflare.md",
      "packages/claxedo-server/scripts/deploy/greenfield-user-deployed.ts",
    ],
    status: "verified",
    verifiedAt: "2026-09-29",
    note: "Owner ruling 2026-09-29.",
  },
  {
    id: "team-plugin-sharing",
    publicWording: "Share skills and MCP servers with your whole team from one repo, on every machine.",
    owner: "Agent Plugins module",
    evidence: [
      "packages/claxedo-server-core/src/agent-plugins/sources/registry.ts",
      "packages/claxedo-server-core/src/agent-plugins/activation/store.ts",
    ],
    status: "verified",
    verifiedAt: "2026-09-29",
    note: "Owner ruling 2026-09-29.",
  },
  {
    id: "bring-your-own-sandbox",
    publicWording: "Bring your own sandbox provider; Claxedo runs sessions in it.",
    owner: "Sandbox manager",
    evidence: [
      "packages/sandbox-contract/src/index.ts",
      "packages/sandbox-manager/docs/architecture.md",
    ],
    status: "verified",
    verifiedAt: "2026-09-29",
    note: "Owner ruling 2026-09-29: bringing your own provider is the only option; there are no direct provider integrations.",
  },
  {
    id: "agent-cli-access",
    publicWording: "Use supported coding agents through Claxedo's chat UI, or run any installed agent CLI in a terminal.",
    owner: "Claxedo App",
    evidence: [
      "packages/agent-runtime-contract/src/harnesses.ts",
      "packages/claxedo-app/src/terminal/agents.ts",
      "packages/claxedo-app/src/terminal/launchers.ts",
    ],
    status: "verified",
    verifiedAt: "2026-09-28",
  },
  {
    id: "harness-coverage",
    publicWording: "Claxedo runs Claude Code, Codex, Cursor, OpenCode and Pi as built-in agents.",
    owner: "Agent runtime",
    evidence: [
      "packages/agent-runtime-contract/src/harnesses.ts",
      "packages/agent-sdk-runtime/src/harness-factories/claude.ts",
      "packages/agent-sdk-runtime/src/harness-factories/codex.ts",
      "packages/agent-sdk-runtime/src/harness-factories/cursor.ts",
      "packages/agent-sdk-runtime/src/harness-factories/pi.ts",
      "packages/workspace-runtime/src/opencode.ts",
    ],
    status: "verified",
    verifiedAt: "2026-09-28",
  },
  {
    id: "connected-placement",
    publicWording: "Run sessions on this computer, on other machines you connect, or in a cloud sandbox, and reopen them from the desktop app, a browser or a phone.",
    owner: "Claxedo runtime",
    evidence: [
      "packages/claxedo-host-connector/src/connector.ts",
      "packages/claxedo-server/src/routes/remote-access.test.ts",
      "packages/claxedo-server/src/workspace/supervisor/sandbox.ts",
      "packages/claxedo-app/src/server/machines.ts",
      "packages/claxedo-app/src/projects/draft-workspaces.ts",
      "packages/claxedo-app/src/server/placement-streams.ts",
      "packages/claxedo-app/src/auth/desktop-binding.ts",
      "packages/claxedo-app/src/auth/browser-binding.ts",
      "packages/claxedo-app/src/lib/viewport.ts",
      "packages/claxedo-app/e2e/flows/33-phone.spec.ts",
      "packages/workspace-relay/src/composition.test.ts",
    ],
    status: "verified",
    verifiedAt: "2026-09-28",
  },
  {
    id: "agent-plugins",
    publicWording: "Standard Agent Plugins make skills and MCP servers available to Claude Code, Codex, Cursor and OpenCode.",
    owner: "Agent Plugins module",
    evidence: [
      "packages/claxedo-server-core/src/agent-plugins/runtime/harness-registry.ts",
      "packages/claxedo-server-core/src/agent-plugins/catalog/validate-plugin.ts",
      "packages/claxedo-local-server/src/agent-plugins/runtime/materialize.ts",
      "packages/claxedo-local-server/src/agent-plugins/runtime/adapters/claude.ts",
      "packages/claxedo-local-server/src/agent-plugins/runtime/adapters/codex.ts",
      "packages/claxedo-local-server/src/agent-plugins/runtime/adapters/cursor.ts",
      "packages/claxedo-local-server/src/agent-plugins/runtime/adapters/opencode.ts",
    ],
    status: "verified",
    verifiedAt: "2026-09-28",
  },
  {
    id: "agent-plugins-follow-you",
    publicWording: "Agent plugins a signed-in user enables reach every environment they sign into: this computer, their connected machines and their cloud sandboxes.",
    owner: "Agent Plugins module",
    evidence: [
      "packages/claxedo-desktop/src/main/agent-plugins-signed-sync.ts",
      "packages/claxedo-desktop/src/main/agent-plugins-signed-sync.test.ts",
      "packages/claxedo-server/src/agent-plugins/hosted-composition.ts",
      "packages/claxedo-server-core/src/agent-plugins/activation/effective.ts",
      "packages/claxedo-local-server/src/agent-plugins/runtime/materialize.ts",
      "packages/claxedo-app/src/marketplace/i18n.ts",
    ],
    status: "verified",
    verifiedAt: "2026-09-28",
  },
  {
    id: "app-plugins-by-prompt",
    publicWording: "An agent can scaffold, check and register an app plugin through the Claxedo MCP tools; the app runs it once the person approves it, and every later save goes live.",
    owner: "App plugins",
    evidence: [
      "packages/claxedo-mcp/src/tools/app-plugins.ts",
      "packages/claxedo-mcp/src/tools/app-plugins-guide.ts",
      "packages/claxedo-plugin-build/src/build.ts",
      "packages/claxedo-plugin-build/src/check.ts",
      "packages/claxedo-plugin-build/src/watch.ts",
      "packages/claxedo-local-server/src/app/local-app.ts",
      "packages/claxedo-app/src/plugins/host.ts",
      "packages/claxedo-app/src/plugins/approval.ts",
      "packages/claxedo-app/src/plugins/live/controller.ts",
      "packages/claxedo-app/e2e/flows/40-app-plugin-tools.spec.ts",
    ],
    status: "verified",
    verifiedAt: "2026-09-28",
  },
  {
    id: "user-deployed-cloudflare",
    publicWording: "A team can deploy its own Claxedo control plane, for one organization, to its own Cloudflare account.",
    owner: "Claxedo server",
    evidence: [
      "public-docs/user-deployed-cloudflare.md",
      "packages/claxedo-server/scripts/deploy/greenfield-user-deployed.ts",
      "packages/claxedo-server/scripts/deploy/greenfield-user-deployed.test.ts",
      "packages/claxedo-server/src/deployments/hosted-shared/user-deployed-product-app.ts",
      "packages/claxedo-server/src/deployments/hosted-workerd/better-auth-d1-candidate-worker.cf.ts",
    ],
    status: "verified",
    verifiedAt: "2026-09-28",
  },
  {
    id: "sandbox-providers",
    publicWording: "Cloud sandboxes run through open-source drivers for exe.dev, Daytona, Modal, Vercel, Cloudflare, Box and Docker, all behind one SandboxDriver contract.",
    owner: "Sandbox manager",
    evidence: [
      "packages/sandbox-contract/src/index.ts",
      "packages/sandbox-manager/src/index.ts",
      "packages/sandbox-manager/src/driver-catalog.ts",
      "packages/sandbox-manager/src/drivers/daytona.ts",
      "packages/sandbox-manager/src/drivers/modal.ts",
      "packages/sandbox-manager/src/drivers/vercel.ts",
      "packages/sandbox-manager/src/drivers/cloudflare.ts",
      "packages/sandbox-manager/src/drivers/docker.ts",
      "packages/sandbox-manager/docs/architecture.md",
      "packages/sandbox-manager/LICENSE",
    ],
    status: "verified",
    verifiedAt: "2026-09-28",
  },
  {
    id: "acp-client",
    publicWording: "Claxedo can present ACP-compatible agents in its structured chat UI.",
    owner: "Agent runtime",
    evidence: [
      "packages/agent-runtime-contract/src/harnesses.ts",
      "packages/agent-sdk-runtime/src/harness-factories/acp.ts",
      "packages/agent-event-runtime/src/harnesses/acp/event-translator.ts",
      "packages/agent-event-runtime/src/harnesses/acp/golden-compat.test.ts",
    ],
    status: "verified",
    verifiedAt: "2026-09-28",
  },
  {
    id: "core-metrics",
    publicWording:
      "In the 29 September 2026 benchmark run, Claxedo beats T3 Code and OpenCode on five core metrics: app start (958 ms; 2.9× and 2.1× faster), session open (48 ms; 2.9× and 2.1×), session return (33 ms; 2.0× and 1.5×), memory after the switching walk (746 MiB; 1.8× and 2.0× less) and idle CPU (0.4% against 2.6% and 16.9%).",
    owner: "Claxedo performance",
    evidence: [
      "docs/reports/2026-09-27-perf-goal-final.md",
      "https://github.com/kyashrathore/agent-app-benchmark/blob/964887d536e26802f0a88bb8ebf8c5778a4c9a8c/README.md#latest-results",
    ],
    note: "Numbers from the 29 September Claxedo-only rerun, paired with T3 Code and OpenCode runs from the same day, as reviewed by the team lead on 2026-09-29; no report for that rerun is in the repository yet. \"Beats\" means wins on medians (owner ruling 2026-09-29).",
    status: "verified",
    verifiedAt: "2026-09-29",
  },
  {
    id: "open-benchmark",
    publicWording:
      "In the open Agent App Benchmark run of 28 September 2026, Claxedo started 2.6× faster than T3 Code and 3× faster than OpenCode from an existing profile, opened sessions for the first time up to 3.3× faster, used 30–48% less memory idle after launch and 0.2% CPU while idle. T3 Code was faster returning to a 1 MiB session, and OpenCode tied on first visits to an 8 MiB session.",
    owner: "Claxedo performance",
    evidence: ["https://github.com/kyashrathore/agent-app-benchmark/blob/cd2b8bc6dae6b157343a56496bc8ac88e624ad55/README.md"],
    status: "verified",
    verifiedAt: "2026-09-28",
  },
  {
    id: "opencode-lineage",
    publicWording: "Claxedo is built on the OpenCode engine.",
    owner: "Claxedo maintainers",
    evidence: ["LICENSE", "packages/workspace-runtime/src/opencode.ts"],
    status: "verified",
    verifiedAt: "2026-09-28",
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
    verifiedAt: "2026-09-28",
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
      "packages/claxedo-local-server/package.json",
      "packages/workspace-relay/package.json",
      "packages/workspace-relay-protocol/package.json",
      "packages/workspace-runtime/package.json",
      "packages/agent-sdk-runtime/package.json",
      "packages/agent-event-runtime/package.json",
      "packages/claxedo-server-core/package.json",
      "packages/sandbox-manager/package.json",
    ],
    status: "verified",
    verifiedAt: "2026-09-28",
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
