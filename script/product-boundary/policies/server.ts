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
  // headroom. The self-hosted composition registers
  // @claxedo/opencode-server-adapter for operator-configured external
  // connections; no OpenCode engine is bundled. The local signed web
  // composition (2026-09-05) adds the embedded issuer's browser descriptor and
  // cookie bridge (`self-hosted-node/embedded-browser-auth.ts` over the shared
  // `browser-auth-security` guard and the Better Auth native-client constants)
  // and the local Agent Plugins module the self-hosted entry mounts from
  // `@claxedo/local-server/agent-plugins/local-composition`, the same module
  // the desktop's server entry mounts. The 37th package is
  // @claxedo/opencode-server-adapter, registered by the self-hosted
  // composition for operator-configured external OpenCode connections; no
  // OpenCode engine is bundled. Re-measured after the generic-harness merge;
  // the values below are exact, not summed.
  ceilings: { modules: 125, packages: 36 },

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
    buildPackages: [
      { packageDir: "packages/agent-runtime-contract" },
      { packageDir: "packages/agent-event-runtime" },
      { packageDir: "packages/agent-sdk-runtime" },
      { packageDir: "packages/opencode-server-adapter" },
      { packageDir: "packages/workspace-relay-protocol" },
      { packageDir: "packages/sandbox-contract" },
      { packageDir: "packages/sandbox-manager" },
      { packageDir: "packages/workspace-relay" },
      { packageDir: "packages/claxedo-connections" },
      { packageDir: "packages/claxedo-channels" },
      { packageDir: "packages/wakes" },
      { packageDir: "packages/workspace-runtime" },
      { packageDir: "packages/claxedo-local-server" },
    ],
    packageExports: [{
      packageDir: "packages/claxedo-local-server",
      exports: [
        "./self-hosted-execution",
        // `deployments/self-hosted-node/start.ts` mounts the local Agent
        // Plugins module behind CLAXEDO_AGENT_PLUGINS=1, the same composition
        // the desktop server entry uses.
        "./agent-plugins/local-composition",
      ],
    }],
    native: ["better-sqlite3", "node-pty"],
    commands: [
      ["bun", "run", "build:self-hosted-boundary"],
      ["bun", "run", "smoke:self-hosted-boundary"],
    ],
  },
}
