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
  forbiddenModules: [`${SRC}/deployments/hosted-node`, `${SRC}/deployments/hosted-workerd`],

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
  /**
   * Measured 121 modules / 39 packages, with no headroom.
   *
   * The reviewed owners this entry is allowed to reach beyond the single
   * binary's own usage pipeline: `@claxedo/local-server`'s Agent Plugins and
   * Tasks compositions, which the desktop's server entry mounts too;
   * `src/tasks/self-hosted-composition.ts`, owned here rather than in
   * `@claxedo/local-server` because it binds THIS deployment's identity — the
   * embedded issuer's bearer verifier and the local SQLite workspace authority
   * — to the Tasks kit, where the loopback composition next to it authorizes
   * every project unconditionally; `src/tasks/session-grants.ts`, owned here
   * for the same reason — it is how a box that is its own runtime host hands
   * its sessions a Tasks grant, which a deployment with a real control-plane
   * boundary does with a signed capability instead;
   * `@claxedo/opencode-server-adapter`, for
   * operator-configured external OpenCode connections, no engine bundled; and
   * `src/mcp/`, which mounts the first-party MCP endpoint and answers for its
   * RFC 9728 document and its own OAuth provider's tokens.
   *
   * Package edges beyond those: `@claxedo/helpers` for the record-narrowing
   * guards five modules here used to define privately, `@claxedo/tasks` reached
   * only through the Tasks composition, and `posthog-node` via platform
   * telemetry.
   *
   * The credential broker's three owners on this entry, no package edge:
   * `src/credentials/sandbox-delivery.ts`, the whole brokered-secret set a
   * cloud sandbox of this deployment must hold, reconciled rather than
   * appended so a revoked account is withdrawn by absence;
   * `src/sandbox/network/workspace-policy.ts`, the egress policy one
   * workspace's sandbox boots with, the user's rows plus the provider hosts
   * implied by the credentials the fanout will send it; and
   * `src/workspace/supervisor/driver-id.ts`, the sandbox driver a workspace
   * runs on, a leaf of its own because the provisioning path and the config
   * push both need it and importing it from either puts the two in a cycle.
   */
  ceilings: { modules: 121, packages: 39 },

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
      `${SRC}/tasks/self-hosted-composition.ts`,
      "packages/claxedo-tasks/src/http/routes.ts",
    ],
  },

  isolation: {
    buildPackages: [
      // `@claxedo/helpers` publishes dist-only subpaths (`/guards`, `/string`)
      // that every package below bundles against; it has no @claxedo/*
      // dependencies, so it builds first.
      { packageDir: "packages/claxedo-helpers" },
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
        // Plugins module, the same composition the desktop server entry uses.
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
