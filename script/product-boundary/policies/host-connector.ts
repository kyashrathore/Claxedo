import type { Policy } from "../policy.ts"

const SRC = "packages/claxedo-host-connector/src"

/**
 * Host Connector: one signing key and one small protocol.
 *
 * This package runs on the user's machine, sometimes headless on a box the
 * owner does not watch. What it depends on IS its security story, not an
 * implementation detail — a connector that imported a server framework would be
 * one refactor away from listening, and a laptop that listens is the attack
 * surface this design avoids by making the connector a pure client.
 *
 * The rule is therefore stricter than any other policy's: NO first-party
 * package at all, and no framework, database, or identity SDK. That is stated
 * as an explicit list rather than as "packages must be empty" because the
 * control below already asserts the walk read real files; an empty-set rule
 * plus an empty result is the shape that passes on a broken walk.
 */
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
    // The connector entry reaches three modules: the identity it signs with,
    // and host-state.ts, because `ack` validates a description's resolved
    // directory against the effective roots inside the connector — the one
    // place no caller can bypass. The transport, bootstrap and node adapter
    // are separate entries and stay out of this graph. Small enough that the
    // required list below is doing the real work.
    minModules: 3,
    requiredModules: [`${SRC}/connector.ts`, `${SRC}/host-identity.ts`, `${SRC}/host-state.ts`],
    // Deliberately EMPTY, and this is the only policy for which that is
    // allowed: the package declares no runtime dependency and imports no bare
    // specifier at all. `requiredModules` above is what proves the walk read
    // something, so the empty package set is a result rather than a silence.
    requiredPackages: [],
  },

  ceilings: { modules: 3, packages: 0 },

  emitted: {
    file: "packages/claxedo-host-connector/.artifacts/u8-package-split/manifests/host-connector.json",
    minModules: 2,
    minChunks: 2,
    requiredModules: [`${SRC}/connector.ts`, `${SRC}/host-identity.ts`],
  },

  isolation: {
    commands: [["bun", "run", "build"], ["bun", "run", "smoke:build"]],
  },
}
