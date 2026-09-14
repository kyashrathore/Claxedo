import type { Policy } from "../policy.ts"

const SRC = "packages/claxedo-local-server/src"

/**
 * The desktop-local server, from the entry the desktop actually starts.
 *
 * `claxedo-desktop/scripts/claxedo-server-entry.ts` starts the server through
 * `@claxedo/local-server/self-hosted-execution` and mounts the feature
 * compositions the same package publishes beside it. That subpath is the entry
 * here, rather than the package's whole `exports` surface: the package-wide
 * walk is `src/architecture/local-closure.test.ts`'s job and answers "what may
 * a consumer import", while this answers "what does the shipped product load".
 * Both are run by `verify:closure`.
 *
 * The forbidden list is the same one that test states, and for the same reason:
 * each entry is a hosted capability an unsigned desktop has no way to use and
 * no business carrying. When this measurement started, the desktop-local entry
 * reached 259 first-party modules and 42 packages — better-auth, channels,
 * connections, wakes — from a build that never signs in.
 */
export const localServer: Policy = {
  id: "local-server",
  summary: "@claxedo/local-server desktop entry (src/self-hosted-execution.ts)",
  packageDir: "packages/claxedo-local-server",
  entry: `${SRC}/self-hosted-execution.ts`,
  roots: [SRC],

  forbiddenPackages: [
    "@claxedo/sandbox-manager",
    "@claxedo/server",
    "@claxedo/channels",
    "@claxedo/connections",
    "@claxedo/wakes",
    "better-auth",
    "posthog-node",
    // Not in the package-wide list, and it belongs here: the desktop server is
    // a child process of Electron, not the renderer, and a UI package in this
    // graph would mean the split leaked in the other direction.
    "@claxedo/app",
  ],
  forbiddenModules: [
    "packages/claxedo-server/src",
    "packages/claxedo-app/src",
    "packages/sandbox-manager/src",
    "packages/claxedo-channels/src",
    "packages/claxedo-connections/src",
    "packages/wakes/src",
  ],

  control: {
    minModules: 30,
    requiredModules: [
      `${SRC}/self-hosted-execution.ts`,
      // The composition this entry exists to start. Absent means the walk
      // stopped at the re-export.
      `${SRC}/app/start-local-server.ts`,
      `${SRC}/app/local-app.ts`,
      `${SRC}/workspace/routes/resolve-route.ts`,
    ],
    // The embedded runtime and the HTTP framework. A walk that read no imports
    // reports neither.
    requiredPackages: ["@claxedo/workspace-runtime", "hono"],
  },

  // Measured 2026-08-09 with `runtimeOnly`. The eight added modules are the
  // complete local usage pipeline (route, durable ports, scanner, pricing
  // port, outbox, host identity, and composition). Shared implementation lives
  // in server-core, so the desktop still reaches no hosted capability package.
  // Tenant-aware sandbox fetch options are a local workspace owner with no
  // hosted capability package: 56 + 1 = 57 modules.
  // 2026-08-29: +1 `embedded-relay-host-auth.ts` — verified actor hop stamp for
  // in-process embedded prompts (`claxedo.author` without managed authority).
  // 2026-09-01: +2 `workspace/user-hosted-serving.ts` + `-routes.ts` — the
  // serving half of remote access (one relay connection for the assigned∩acked
  // set, pushed from Electron main). Reviewed owner: workspace domain.
  // 2026-09-02: +1 `workspace/user-hosted-surface.ts` — what a relayed request
  // may reach on this machine for its workspace (deny/root/workspace verdict),
  // imported only by `user-hosted-serving.ts`; no new package. Reviewed owner:
  // workspace domain.
  // Removing the retired local user-extension route subtracts one module.
  // External OpenCode connections are registered by the local composition via
  // @claxedo/opencode-server-adapter; this transport adds one package, not an
  // embedded engine. AgentConfigRoutes also owns provider-routes.ts: the
  // authenticated Pi catalog reads control-plane credentials, not a workspace
  // engine. Shell project-routes.ts owns authorized project metadata reads and
  // edits against the existing workspace store: exactly 57 modules, 22 packages.
  // 2026-09-06: +1 `platform/json.ts` — one dependency-free leaf that reads
  // untrusted JSON (request bodies, runtime event payloads, subprocess output).
  // It replaced the private `record`/`text` pairs eight modules in this package
  // had each written inline, so it adds a module without adding a package edge
  // or any new reach. Reviewed owner: local-server platform. Re-measured, not
  // summed: 54 modules, 21 packages.
  // +1 package (2026-09-06): @claxedo/helpers, reached through the shared
  // server-core surface (see server.ts for the owner). Re-measured, not
  // summed: 54 modules, 22 packages.
  // +1 package: @claxedo/mcp, the first-party MCP endpoint the desktop-local
  // composition mounts at `/api/claxedo/mcp` for the sessions it launches
  // (runtime credential only). It reaches only the MCP SDK, hono, zod, helpers
  // and the runtime contract, all already in this closure. Re-measured, not
  // summed: 54 modules, 23 packages.
  // +1 module / 0 packages (2026-09-07): reviewed owner
  // `agent-config/hosted-mcp-install.ts`, the one-click write of the hosted
  // `claxedo` MCP entry into the Claude Code, Cursor and Codex configs on this
  // machine. It belongs to this product because the desktop's own agent-config
  // routes are what a user clicks, and it reads node builtins only — no
  // package edge. Re-measured, not summed: 55 modules, 23 packages.
  // smol-toml validates the hosted MCP installer's Codex configuration before any file is written.
  // +1 module: shell/event-stream-response carries the authorized event
  // producer over HTTP or WebSocket. Measured 56 / 24; no new package edge.
  // +1 module: app/local-documents composes the shared repository/managed
  // document backend for unsigned desktop editing. No hosted adapter edge.
  // +1 module / +1 package: `credentials/broker.ts` and @claxedo/egress-broker,
  // the loopback credential broker this composition mounts at `/bindings/*` and
  // the authority behind it. The package is the broker's request policy,
  // injection, mount gate and runtime-token verification; it reaches `jose`,
  // `@hono/node-server` and @claxedo/agent-runtime-contract, all already in
  // this closure. It belongs to this product because the desktop-local server
  // is the process that holds the credential value and the harness never does.
  // The table naming each provider's vendor host, allowed methods and paths
  // and header shape is a fact about the vendor rather than about this
  // machine, so it is owned by server-core, where the cloud delivery adapter
  // reads the same rows; it adds no module or package edge here.
  // +1 module: `credentials/machine-credentials.ts`, the credential port for a
  // server running on the machine the harnesses live on. Asking a CLI what it
  // is signed in as, and withdrawing the stored mark so a harness runs on that
  // login, are operations with no referent on a host where no harness is
  // installed, so they are composed here and left off the shared default.
  // It reaches only the machine-login reader and the registry.
  // +1 module: `credentials/operations/drop-copied-harness-logins.ts`, the
  // one-time delete of the harness logins an older Claxedo copied off this
  // machine. It belongs to this product because this is the process that ran
  // that scan, and it reaches only the registry and the machine-login reader.
  // +1 module: `usage/adapters/token-tracker-usage-limits.ts`, the plan probe
  // for every agent installed on this machine, which only a server running on
  // that machine can ask. It reaches tokentracker-cli and this package's JSON
  // narrowing, both already here — the history adapter beside it already
  // carries that dependency. No new package edge.
  // +1 module: reviewed owner `agent-plugins/builtin-groups.ts`, reading the
  // `agent-plugins/activation/sqlite-store.ts` this closure already holds. The
  // first-party MCP endpoint this product mounts serves only the tool groups
  // this machine consented to, and those rows are the Marketplace's own,
  // written by the activation routes in this same package — a second
  // resolution on the server side would be a second answer to the same
  // question. No new package edge.
  // +1 package: @claxedo/agent-runtime-contract, reviewed owner of the harness
  // table (which provider ids each harness answers to, and which one a connect
  // card signs in with) and of the credential-broker error vocabulary. The
  // desktop server reads both — it serves the connect card and mounts the
  // broker — and the package is data and pure functions with no dependencies
  // of its own.
  // Full closure measured at 62 modules / 26 packages.
  // -2 modules / +1 package: `workspace/user-hosted-serving.ts` and
  // `workspace/user-hosted-surface.ts` moved verbatim to @claxedo/host-serving,
  // the reviewed owner of the serving half of remote access, so the desktop
  // daemon and a `claxedo connect` host dial the relay through one loop. The
  // daemon keeps only its loopback control route, which hands the package the
  // embedded runtimes' `sessionAuthority`. The package reaches server-core's
  // log and peer-address leaves and the workspace-runtime relay subpath, all
  // already here. Re-measured, not summed: 60 modules, 27 packages.
  ceilings: { modules: 60, packages: 27 },

  emitted: {
    file: "packages/claxedo-local-server/.artifacts/u8-package-split/manifests/local-server.json",
    minModules: 500,
    minChunks: 1,
    requiredModules: [
      // The facade is all re-exports and therefore has no generated range in
      // Bun's source map. `entry` above still pins it; these prove its bodies.
      `${SRC}/app/start-local-server.ts`,
      `${SRC}/app/local-app.ts`,
      "packages/claxedo-server-core/src/platform/db/db.ts",
    ],
  },

  isolation: {
    native: ["node-pty", "better-sqlite3"],
    // These packages publish dist-only exports. Build them in dependency order
    // inside the isolated workspace so the Local Server bundle never consumes
    // outputs left behind by a developer's existing checkout.
    buildPackages: [
      // `@claxedo/helpers` publishes dist-only subpaths (`/guards`, `/string`)
      // that every package below bundles against; it has no @claxedo/*
      // dependencies, so it builds first.
      { packageDir: "packages/claxedo-helpers" },
      // server-core's agent-config, workspace store and sandbox routes read the
      // driver contract; its published subpath is dist-only.
      { packageDir: "packages/sandbox-contract" },
      { packageDir: "packages/agent-runtime-contract" },
      { packageDir: "packages/agent-event-runtime" },
      { packageDir: "packages/agent-sdk-runtime" },
      { packageDir: "packages/opencode-server-adapter" },
      // The loopback credential broker the desktop composition mounts; its
      // published entry is dist-only and it bundles against
      // @claxedo/agent-runtime-contract, built above it.
      { packageDir: "packages/egress-broker" },
      { packageDir: "packages/workspace-relay-protocol" },
      { packageDir: "packages/workspace-relay" },
      { packageDir: "packages/workspace-runtime" },
    ],
    commands: [["bun", "run", "build"], ["bun", "run", "smoke:build"]],
  },
}
