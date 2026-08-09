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
    "convex",
    "better-auth",
    "better-sqlite3",
    "drizzle-orm",
    "@clerk/clerk-js",
    // The connector runs under Node, Bun and Electron. `crypto.subtle` is the
    // one implementation all three share; a `node:crypto` import works in
    // development and fails wherever the runtime differs.
    "node:crypto",
  ],
  forbiddenModules: [],

  control: {
    // Four source files, two of them tests. The production graph is genuinely
    // two modules — so this is the one policy where the minimum is small
    // enough that the required list below is doing the real work.
    minModules: 2,
    requiredModules: [`${SRC}/connector.ts`, `${SRC}/host-identity.ts`],
    // Deliberately EMPTY, and this is the only policy for which that is
    // allowed: the package declares no runtime dependency and imports no bare
    // specifier at all. `requiredModules` above is what proves the walk read
    // something, so the empty package set is a result rather than a silence.
    requiredPackages: [],
  },

  ceilings: { modules: 2, packages: 0 },

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
