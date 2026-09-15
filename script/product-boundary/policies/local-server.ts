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

  // Measured with `runtimeOnly` — re-run, never summed: 60 modules, 27
  // packages. What the desktop entry reaches beyond the composition and the
  // workspace routes, and why each owner is this product's:
  //  - the local usage pipeline (route, durable ports, scanner, pricing port,
  //    outbox, host identity, composition) and the tenant-aware sandbox fetch
  //    options: local workspace owners with no hosted capability package.
  //  - `embedded-relay-host-auth.ts`: the verified actor hop stamp for
  //    in-process embedded prompts (`claxedo.author` without managed authority).
  //  - `workspace/user-hosted-serving-routes.ts`: the loopback control route
  //    through which Electron main hands the serving credential and the
  //    embedded runtimes' `sessionAuthority` to @claxedo/host-serving, the
  //    reviewed owner of the serving half of remote access (one relay loop for
  //    the assigned∩acked set, and the per-workspace surface a relayed request
  //    may reach) for this daemon and a `claxedo connect` host alike. That
  //    package reaches server-core's log and peer-address leaves and the
  //    workspace-runtime relay subpath, all already here.
  //  - `platform/json.ts`: the one dependency-free leaf every reader of
  //    untrusted JSON (request bodies, runtime event payloads, subprocess
  //    output) narrows through.
  //  - `agent-config/hosted-mcp-install.ts` (owner: local-server platform): the
  //    one-click write of the hosted `claxedo` MCP entry into the Claude Code,
  //    Cursor and Codex configs on this machine; smol-toml validates the Codex
  //    configuration before any file is written.
  //  - `shell/event-stream-response.ts`: the authorized event producer over
  //    HTTP or WebSocket.
  //  - `app/local-documents.ts`: the shared repository/managed document
  //    backend composed for unsigned desktop editing.
  //  - `credentials/broker.ts` and @claxedo/egress-broker: the loopback
  //    credential broker mounted at `/bindings/*` and the authority behind it
  //    (request policy, injection, mount gate, runtime-token verification).
  //    The desktop-local server is the process that holds the credential value
  //    and the harness never does. The table naming each provider's vendor
  //    host, methods, paths and header shape is a fact about the vendor, so
  //    server-core owns it and the cloud delivery adapter reads the same rows.
  //  - `credentials/machine-credentials.ts`: asking a CLI what it is signed in
  //    as, and withdrawing the stored mark so a harness runs on that login —
  //    operations with no referent on a host where no harness is installed.
  //  - `credentials/operations/drop-copied-harness-logins.ts`: the one-time
  //    delete of the harness logins an older Claxedo copied off this machine;
  //    this is the process that ran that scan.
  //  - `usage/adapters/token-tracker-usage-limits.ts`: the plan probe for
  //    every agent installed on this machine, which only a server running on
  //    that machine can ask; tokentracker-cli is already carried by the
  //    history adapter beside it.
  //  - `agent-plugins/builtin-groups.ts`: the tool groups this machine
  //    consented to, read from the Marketplace's own activation rows in
  //    `agent-plugins/activation/sqlite-store.ts`, so the first-party MCP
  //    endpoint has one answer to that question.
  // Packages beyond the framework and the runtime: @claxedo/helpers through
  // the shared server-core surface; @claxedo/mcp, the first-party MCP endpoint
  // mounted at `/api/claxedo/mcp` for the sessions this composition launches
  // (runtime credential only; reaches the MCP SDK, hono, zod, helpers and the
  // runtime contract); @claxedo/opencode-server-adapter, the transport for
  // external OpenCode connections; @claxedo/agent-runtime-contract, the
  // dependency-free owner of the harness table and the credential-broker
  // error vocabulary; @claxedo/host-serving and @claxedo/egress-broker as
  // above.
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
