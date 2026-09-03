import type { Policy } from "../policy.ts"

const SRC = "packages/claxedo-server/src"

/**
 * `@claxedo/server` ships one Node production entry: the single binary
 * (`self-hosted-node`), which genuinely runs workspaces. The retired cloud
 * compositions (`hosted-node`, `hosted-workerd/worker.ts`) were removed; the
 * Better Auth + D1 worker compositions verify their own closures in-package.
 */

export const serverSelfHosted: Policy = {
  id: "server-self-hosted",
  summary: "@claxedo/server self-hosted single binary (src/deployments/self-hosted-node/index.ts)",
  packageDir: "packages/claxedo-server",
  entry: `${SRC}/deployments/self-hosted-node/index.ts`,
  roots: [SRC],

  forbiddenPackages: [
    // Reaching `@claxedo/local-server` is CORRECT for this entry and only this
    // entry — the single binary genuinely runs local workspaces. What it must
    // not reach is the desktop shell around it.
    "electron",
    "@claxedo/desktop",
  ],
  forbiddenModules: [
    `${SRC}/deployments/hosted-node`,
    `${SRC}/deployments/hosted-workerd`,
  ],

  control: {
    minModules: 50,
    requiredModules: [
      `${SRC}/deployments/self-hosted-node/index.ts`,
      // The composition guard this app installs alongside the hosted core.
      `${SRC}/deployments/route-ownership.ts`,
    ],
    // The local-execution port is the ONE declared subpath by which this entry
    // is allowed to reach the desktop package. Required rather than forbidden,
    // so that a walk which lost the edge fails loudly instead of reporting a
    // cleaner-than-real self-hosted product.
    requiredPackages: ["@claxedo/local-server", "better-sqlite3", "better-auth"],
  },
  // Nine modules complete the single-binary usage pipeline: central/local
  // routes, durable revision/provenance stores, outbox, scanner, pricing, and
  // host identity. The canonical private-session reservation route adds one
  // source module. Runtime authority now consumes the relay-protocol package's
  // shared stream/turn lease TTL contract. `relay-token-record.ts`, the one
  // owner of user-vs-service runtime token recording shared with the hosted
  // compositions, adds one source module. Package reach includes `posthog-node`
  // via platform telemetry (`platform/telemetry/errors/posthog.ts`). The
  // workspace SessionEnv split keeps transport/protocol/admission policy in
  // focused, already-reachable owners and adds four source modules.
  // -32 modules / -3 packages: retiring the hosted work-ledger service took its
  // host composition, the self-hosted capability seam, and the service package
  // with its transitive pins out of the single binary. Re-measured, no
  // headroom: 123 modules and 32 packages.
  ceilings: { modules: 123, packages: 32 },

  emitted: {
    file: "packages/claxedo-server/.artifacts/u8-package-split/manifests/server-self-hosted.json",
    minModules: 2_500,
    minChunks: 1,
    requiredModules: [
      `${SRC}/deployments/self-hosted-node/index.ts`,
      `${SRC}/deployments/self-hosted-node/app.ts`,
      "packages/claxedo-local-server/src/self-hosted-execution.ts",
      // Chat SDK adapters remain externalized behind `@claxedo/channels` and
      // are verified by that package rather than duplicated into this bundle.
    ],
  },

  isolation: {
    additionalPackageDirs: ["packages/opencode"],
    additionalFiles: [".github/TEAM_MEMBERS"],
    buildPackages: [
      { packageDir: "packages/agent-event-runtime" },
      { packageDir: "packages/agent-extensions" },
      { packageDir: "packages/agent-sdk-runtime" },
      { packageDir: "packages/workspace-relay-protocol" },
      { packageDir: "packages/sandbox-contract" },
      { packageDir: "packages/sandbox-manager" },
      { packageDir: "packages/workspace-relay" },
      { packageDir: "packages/claxedo-connections" },
      { packageDir: "packages/claxedo-channels" },
      { packageDir: "packages/wakes" },
      { packageDir: "packages/workspace-runtime" },
      { packageDir: "packages/claxedo-mcp" },
      { packageDir: "packages/claxedo-local-server" },
      {
        packageDir: "packages/opencode",
        script: "build:node",
        inputOnly: true,
        environment: {
          OPENCODE_CHANNEL: "selfhost-boundary",
          OPENCODE_VERSION: "0.0.0-boundary",
        },
      },
    ],
    packageExports: [{
      packageDir: "packages/claxedo-local-server",
      exports: ["./self-hosted-execution"],
    }],
    native: ["better-sqlite3", "node-pty"],
    commands: [
      ["bun", "run", "build:self-hosted-boundary"],
      ["bun", "run", "smoke:self-hosted-boundary"],
    ],
  },
}
