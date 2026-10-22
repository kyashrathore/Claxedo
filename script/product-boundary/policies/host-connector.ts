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
    // The connector entry is one module of its own plus one package edge:
    // `ack` validates a description's resolved directory against the
    // effective roots inside the connector — the one place no caller can
    // bypass — by the contract's host-path, the directory form the control
    // plane stores and compares by, so both sides refuse the same paths.
    // host-state.ts is reached by type only. The entry reaches no key
    // material: the machine signature belongs to the transport, which is a
    // separate entry, as are bootstrap and the node adapter. Small enough
    // that the required list below is doing the real work.
    minModules: 1,
    requiredModules: [`${SRC}/connector.ts`],
    // Signing and sealing enter through separate entrypoints; the one
    // package here is the wire contract, for its import-free path module.
    requiredPackages: ["@claxedo/account-contract"],
  },

  ceilings: { modules: 1, packages: 1 },

  emitted: {
    file: "packages/claxedo-host-connector/.artifacts/u8-package-split/manifests/host-connector.json",
    minModules: 2,
    minChunks: 2,
    // The connector and the path module it bundles. `host-identity` is still
    // a built chunk — the transport and bootstrap entries import it — but
    // nothing on the connector entry's path does.
    requiredModules: [`${SRC}/connector.ts`, "packages/account-contract/src/host-path.ts"],
  },

  isolation: {
    // The signing, sealing and bootstrap entries build from the machine wire
    // codecs and the base64url helpers under them, whose published subpath is
    // dist-only; the connector entry above reaches neither.
    additionalPackageDirs: ["packages/account-contract"],
    buildPackages: [{ packageDir: "packages/claxedo-helpers", inputOnly: true }],
    commands: [
      ["bun", "run", "build"],
      ["bun", "run", "smoke:build"],
    ],
  },
}
