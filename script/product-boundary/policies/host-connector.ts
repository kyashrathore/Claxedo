import type { Policy } from "../policy.ts"

const SRC = "packages/claxedo-host-connector/src"

export const hostConnector: Policy = {
  id: "host-connector",
  summary: "@claxedo/host-connector enrollment client (src/connector.ts)",
  packageDir: "packages/claxedo-host-connector",
  entry: `${SRC}/connector.ts`,
  roots: [SRC],

  forbiddenPackages: [
    "@claxedo/server",
    "@claxedo/server-core",
    "@claxedo/local-server",
    "@claxedo/app",
    "@claxedo/desktop",
    "@claxedo/workspace-runtime",
    "@claxedo/sandbox-manager",
    "hono",
    "express",
    "better-auth",
    "better-sqlite3",
    "drizzle-orm",
    // The connector runs under Node, Bun and Electron. `crypto.subtle` is the
    // one implementation all three share; a `node:crypto` import works in
    // development and fails wherever the runtime differs.
    "node:crypto",
  ],
  forbiddenModules: [],

  control: {
    // The connector entry reaches two modules: itself and host-state.ts,
    // because `ack` validates a description's resolved directory against the
    // effective roots inside the connector — the one place no caller can
    // bypass. It reaches no key material: the machine signature belongs to
    // the transport, which is a separate entry, as are bootstrap and the node
    // adapter. Small enough that the required list below is doing the real
    // work.
    minModules: 2,
    requiredModules: [`${SRC}/connector.ts`, `${SRC}/host-state.ts`],
    // Signing and sealing enter through separate entrypoints; the assignment
    // connector reaches only its state adapter, so this closure has no packages.
    requiredPackages: [],
  },

  ceilings: { modules: 2, packages: 0 },

  emitted: {
    file: "packages/claxedo-host-connector/.artifacts/u8-package-split/manifests/host-connector.json",
    minModules: 2,
    minChunks: 2,
    // The same two the source walk reaches. `host-identity` is still a built
    // chunk — the transport and bootstrap entries import it — but nothing on
    // the connector entry's path does.
    requiredModules: [`${SRC}/connector.ts`, `${SRC}/host-state.ts`],
  },

  isolation: {
    commands: [
      ["bun", "run", "build"],
      ["bun", "run", "smoke:build"],
    ],
  },
}
