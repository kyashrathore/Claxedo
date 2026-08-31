import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { Hono } from "hono"
import { createSelfHostedApp } from "./app"
import { DuplicateRouteOwner, withRouteOwnership } from "../route-ownership"
import { createControlPlaneServices } from "../../authority/services"
import { createSqliteCentralStore } from "../../authority/adapters/sqlite/central-store"

/**
 * Who owns what in the self-hosted composition.
 *
 * `createSignedControlPlaneApp` has recorded its mounts since the hosted/shared
 * split; this is the second composition to do it, and the two ledgers are what
 * make a combined app checkable instead of order-dependent.
 *
 * What the guard does and does not buy here is worth being exact about, because
 * a guard believed to cover more than it does is worse than none. Inside one
 * composition there is one owner, and `createRouteOwnership` deliberately lets
 * an owner re-claim its own prefix — `/api/workspace` carries both
 * `WorkspaceRoutes` and `WorkspaceCheckpointRoutes` on purpose. So this does
 * NOT catch a duplicate written inside `createSelfHostedApp`. It catches a
 * SECOND composition mounting onto the same app, which is the arrangement the
 * package split creates and the one Hono resolves silently by call order.
 */

let dataDir: string
let savedDataDir: string | undefined

beforeEach(() => {
  savedDataDir = process.env.CLAXEDO_DATA_DIR
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-self-hosted-ownership-"))
  process.env.CLAXEDO_DATA_DIR = dataDir
})

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = savedDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

function selfHosted() {
  const centralStore = createSqliteCentralStore({ mode: () => "workspace_replicated" })
  return createSelfHostedApp(
    createControlPlaneServices(
      {
        projectionStore: centralStore.projectionStore,
        durableSessionLog: centralStore.durableSessionLog,
      },
      { localExecution: { enabled: true }, telemetry: { capture: () => {} } },
    ),
  )
}

/**
 * Every prefix `createSelfHostedApp` claims, measured from the composition.
 *
 * Committed rather than derived so that a new mount point — including one added
 * by a `mount*` helper that runs against this app, such as the channels
 * ingress — is a line in a diff. The owner is uniform today; it stops being
 * uniform the moment a shared core is composed in, and that is the change this
 * table is here to make visible.
 */
const SELF_HOSTED_MOUNTS = [
  { prefix: "/", owner: "self-hosted-node" },
  { prefix: "/api/channels", owner: "self-hosted-node" },
  { prefix: "/api/claxedo/agent-config", owner: "self-hosted-node" },
  { prefix: "/api/claxedo/credentials", owner: "self-hosted-node" },
  { prefix: "/api/claxedo/integrations", owner: "self-hosted-node" },
  { prefix: "/api/claxedo/network-policy", owner: "self-hosted-node" },
  { prefix: "/api/claxedo/project", owner: "self-hosted-node" },
  { prefix: "/api/claxedo/remote-access", owner: "self-hosted-node" },
  { prefix: "/api/claxedo/workspace", owner: "self-hosted-node" },
  { prefix: "/api/control", owner: "self-hosted-node" },
  { prefix: "/api/runtime-authority", owner: "self-hosted-node" },
  { prefix: "/api/workspace", owner: "self-hosted-node" },
  { prefix: "/documents", owner: "self-hosted-node" },
  { prefix: "/internal/documents", owner: "self-hosted-node" },
]

describe("the self-hosted route ledger", () => {
  test("records every mount the composition makes", () => {
    expect(selfHosted().routeOwnership.mounts()).toEqual(SELF_HOSTED_MOUNTS)
  })

  test("the ledger is filled by composing, not by the table above", () => {
    // Positive control. `mounts()` returning [] would satisfy a subset check
    // and would satisfy every "does not collide" assertion below.
    const built = selfHosted()

    expect(built.routeOwnership.owner("/api/workspace")).toBe("self-hosted-node")
    expect(built.routeOwnership.owner("/api/claxedo/never-mounted")).toBeUndefined()
  })
})

describe("the guard on the composed app", () => {
  test("refuses a second composition claiming a prefix this one owns", () => {
    // The real failure being prevented: a shared signed core mounted onto the
    // self-hosted app would shadow, or be shadowed by, whichever ran first.
    const built = selfHosted()

    expect(() =>
      withRouteOwnership(built.app, built.routeOwnership, "shared-signed-core").route(
        "/api/workspace",
        new Hono() as never,
      ),
    ).toThrow(DuplicateRouteOwner)
  })

  test("names both compositions, because the fix has to know which mount to drop", () => {
    const built = selfHosted()

    expect(() =>
      withRouteOwnership(built.app, built.routeOwnership, "shared-signed-core").route(
        "/documents",
        new Hono() as never,
      ),
    ).toThrow(/self-hosted-node.*shared-signed-core/)
  })

  test("still lets this composition mount twice under one prefix", () => {
    // `/api/workspace` already carries two route objects. A rule that failed
    // on that would break a working composition to enforce a rule about a
    // different problem.
    const built = selfHosted()

    expect(() => built.app.route("/api/workspace", new Hono() as never)).not.toThrow()
  })

  test("the guard is installed on the app the composition returns, not a copy", async () => {
    // Positive control for the three assertions above: they would all hold on
    // a bare Hono that had never been wrapped, which is exactly what an
    // accidentally-unwrapped composition returns.
    const built = selfHosted()

    expect(await (await built.app.request("/api/claxedo/health")).json()).toMatchObject({ ok: true })
    built.app.route("/api/claxedo/probe", new Hono() as never)
    expect(built.routeOwnership.owner("/api/claxedo/probe")).toBe("self-hosted-node")
  })
})
