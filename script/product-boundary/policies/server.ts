import type { Policy } from "../policy.ts"

const SRC = "packages/claxedo-server/src"

const FORBIDDEN_MODULES = [
  `${SRC}/deployments/hosted-node`,
  `${SRC}/deployments/hosted-workerd`,
]

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
  forbiddenModules: FORBIDDEN_MODULES,

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
  // +7 modules / 0 packages (2026-09-06, oxlint type-aware sweep). Two distinct
  // causes, both intentional. Four are new value imports of a canonical owner
  // that replaced a local copy: platform/json/index.ts and platform/http/status.ts
  // from session/machine-wakes.ts, platform/errors/index.ts from
  // documents/session-hydration.ts, channels/channel-id.ts from
  // channels/control-plane.ts, and authority/composed-authority.ts from
  // self-hosted-node/app.ts. The other two were ALREADY imported here, but as
  // `import type`, which erases and so never entered the walk: documents/port.ts
  // and sandbox/stores/lease-row.ts now also carry the runtime converters
  // (`toDocumentVersion`, `toSnapshotID`, `toSandboxLeaseRow`, `holdOwnerType`)
  // that replaced the casts at those two seams. A checked conversion is a
  // runtime module where a cast was free; that cost is the point.
  // Every module is inside packages/claxedo-server itself, so the package count
  // is unchanged at 36.
  // +1 module: connections/stored-columns.ts. Both connection backends persist
  // the same two JSON columns; the decoders first landed in store-adapter.ts,
  // which pulled the SQLite-only `connection.sql` Drizzle table into the hosted
  // D1 worker's graph, where wrangler emitted it as an unloadable additional
  // module. The decoders own a shared concept with no schema dependency, so
  // they are their own file, imported by store-adapter.ts and hosted-d1/.
  // Re-measured, no headroom.
  // +1 module: `connections/credential-store-adapter.ts`, now the ONE
  // `CredentialStorePort` implementation for both hosts. It is its own file
  // rather than part of `connections/store-adapter.ts` on purpose — the hosted
  // Worker composition imports it too, and `store-adapter.ts` reaches SQLite
  // (`platform/db`), which must never enter the Worker graph. No package edge.
  // +1 package: `@claxedo/helpers`, the canonical owner of the record-narrowing
  // guards that `workspace/signed-access.ts`, `workspace/routes/index.ts`,
  // `workspace/runtime-token-guards.ts`, `workspace/local-host.ts` and
  // `hosts/workspace-runtime/workspace-session-admission.ts` each defined
  // privately. The `/guards` subpath has zero imports and no host APIs, so it
  // brings no transitive edge. Re-measured, no headroom: 134/37.
  // +1 module / +1 package: `src/mcp/first-party-mcp.ts` mounts the
  // first-party MCP endpoint (`/api/claxedo/mcp`) from `@claxedo/mcp`, the
  // owner of the route, its credential model and its tool registry; the node
  // admits the CLI JWT and its own unsigned loopback caller there. The package
  // reaches only the MCP SDK, hono, zod, helpers and the runtime contract.
  // Re-measured, no headroom: 135/38.
  // +2 modules: `src/mcp/oauth-protected-resource.ts` and the scope/resource
  // names it shares with the OAuth provider, `platform/auth/mcp-oauth-scopes.ts`.
  // The MCP endpoint's own 401 challenge names the RFC 9728 document, so the
  // deployment that mounts the endpoint is the one that must answer for it.
  // The scope module is deliberately dependency-free — it is in every auth
  // composition's closure, including the Worker's, and reading the names from
  // `@claxedo/mcp` would drag the MCP SDK in behind them. No package edge.
  // Re-measured, no headroom: 137/38.
  // +1 module: `src/mcp/oauth-credential.ts` reads the claims of an access
  // token this box's own OAuth provider issued, so a host that completed
  // consent is admitted at the MCP endpoint instead of answered 401. It is
  // owned here rather than in `@claxedo/mcp` because the scope-to-credential
  // rule is a deployment's policy over its own authorization server, and it
  // reaches only `@claxedo/helpers/string` and the scope module already in
  // this closure. No package edge. Re-measured, no headroom: 139/38.
  // Consent revocation shares platform/auth/oauth-consent-revocation.ts across both OAuth providers.
  // +1 package (2026-09-12): `src/tasks/self-hosted-composition.ts`,
  // the SIGNED posture's Tasks composition, selected in
  // `deployments/self-hosted-node/start.ts` from the composed
  // `services.auth.config.enabled`. It is owned here and not in
  // `@claxedo/local-server` because it binds THIS deployment's identity — the
  // embedded issuer's bearer verifier and the local SQLite workspace authority
  // — to the kit, and the loopback composition next to it authorizes every
  // project unconditionally. The new package edge is `@claxedo/tasks`, reached
  // only through that module. Measured 115 -> 116 modules and
  // 38 -> 39 packages; only the package ceiling is raised, because the module
  // ceiling above already sits well over what this entry reaches.
  ceilings: { modules: 139, packages: 39 },

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
