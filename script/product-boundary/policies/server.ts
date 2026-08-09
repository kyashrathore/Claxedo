import type { Policy } from "../policy.ts"

const SRC = "packages/claxedo-server/src"

/**
 * `@claxedo/server` ships three production entries, and they are three
 * different products.
 *
 * Two cloud compositions (`hosted-node`, `hosted-workerd`) are signed,
 * multi-tenant, and run no workspace on their own box. One single binary
 * (`self-hosted-node`) genuinely does. They share `src/`, so the only thing
 * keeping them apart is which modules each entry can REACH — and reachability
 * is not visible in a composition file, which lists what a deployment mounts
 * rather than what its graph drags along.
 *
 * That is why the plan gives this package three policies and one
 * `verify:closure` that runs all of them: "Server's `verify:closure` performs
 * cloud Node, workerd, and self-hosted Node entry builds/smokes because those
 * deployments do not share one emitted closure."
 */

const cloudControl = (entry: string) => ({
  minModules: 50,
  requiredModules: [entry, `${SRC}/deployments/hosted-shared/hosted-app.ts`],
  requiredPackages: ["convex", "hono"],
})

export const serverCloudNode: Policy = {
  id: "server-cloud-node",
  summary: "@claxedo/server hosted Node deployment (src/deployments/hosted-node/index.ts)",
  packageDir: "packages/claxedo-server",
  entry: `${SRC}/deployments/hosted-node/index.ts`,
  roots: [SRC],

  forbiddenPackages: [
    // The desktop product: PTY proxying, the local credential store, the
    // embedded Workspace Runtime, the OpenCode compat routes. Nothing else
    // catches this — the Worker's forbidden-bare list names
    // `@claxedo/workspace-runtime` and `better-sqlite3` but not this package,
    // and neither walk follows a bare specifier, so a cloud entry importing the
    // desktop package drags none of the named packages into its own graph and
    // passes every other gate.
    "@claxedo/local-server",
    "electron",
    "@claxedo/app",
  ],
  // `hosted-node/index.ts` had no import-graph gate of ANY kind before
  // `deployment-closures.test.ts`, and it is the entry most able to reach the
  // single binary by accident: both run on Node, so nothing about a
  // `better-sqlite3` or `node:fs` edge would break the build the way it breaks
  // a Worker bundle. The cloud plane pulling in embedded auth, the SQLite
  // authority and local execution would simply work in CI and be wrong in
  // production.
  forbiddenModules: [`${SRC}/deployments/self-hosted-node`],

  control: cloudControl(`${SRC}/deployments/hosted-node/index.ts`),
  // +1 package: the dependency-neutral sandbox identity/config contract moved
  // out of sandbox-manager so local/server-core no longer reach lifecycle code.
  ceilings: { modules: 132, packages: 26 },
}

export const serverWorkerd: Policy = {
  id: "server-workerd",
  summary: "@claxedo/server hosted workerd deployment (src/deployments/hosted-workerd/worker.ts)",
  packageDir: "packages/claxedo-server",
  entry: `${SRC}/deployments/hosted-workerd/worker.ts`,
  roots: [SRC],

  forbiddenPackages: [
    "@claxedo/local-server",
    "electron",
    "@claxedo/app",
    // Node-only, in a runtime that has no Node. `worker.import-graph.test.ts`
    // owns the full workerd-safety rule set including the marked-module
    // convention; these are the two that also express the PRODUCT boundary.
    "better-sqlite3",
    "@claxedo/workspace-runtime",
  ],
  // The package owns all three deployments, so its package manifest correctly
  // declares Node/self-host dependencies. The Workerd ENTRY still cannot emit
  // them; the source and normalized Wrangler graphs own that narrower rule.
  manifestForbiddenPackages: ["electron", "@claxedo/app", "@claxedo/desktop"],
  forbiddenModules: [
    `${SRC}/deployments/self-hosted-node`,
    "packages/claxedo-local-server/src",
    "packages/workspace-runtime/src",
  ],

  control: cloudControl(`${SRC}/deployments/hosted-workerd/worker.ts`),
  ceilings: { modules: 108, packages: 13 },

  emitted: {
    file: "packages/claxedo-server/.artifacts/u8-package-split/manifests/server-workerd.json",
    minModules: 1_500,
    minChunks: 1,
    requiredModules: [
      `${SRC}/deployments/hosted-workerd/worker.ts`,
      `${SRC}/deployments/hosted-shared/hosted-app.ts`,
      `${SRC}/hosts/workgraph/hosted/runtime.ts`,
    ],
  },

  isolation: {
    buildPackages: [
      { packageDir: "packages/agent-event-runtime", inputOnly: true },
      { packageDir: "packages/agent-extensions", inputOnly: true },
      { packageDir: "packages/agent-sdk-runtime" },
      { packageDir: "packages/workspace-relay-protocol" },
      { packageDir: "packages/sandbox-contract", inputOnly: true },
      { packageDir: "packages/sandbox-manager" },
      { packageDir: "packages/workspace-relay" },
      { packageDir: "packages/claxedo-connections" },
      { packageDir: "packages/wakes" },
      { packageDir: "packages/workspace-runtime", inputOnly: true },
      { packageDir: "packages/workgraph" },
    ],
    commands: [
      ["bun", "run", "build:workerd-boundary"],
      ["bun", "run", "smoke:workerd-boundary"],
    ],
  },
}

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
  forbiddenModules: [],

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
  // Same intentional contract edge as hosted Node; no module or provider SDK
  // entered the composition.
  ceilings: { modules: 141, packages: 33 },
}
