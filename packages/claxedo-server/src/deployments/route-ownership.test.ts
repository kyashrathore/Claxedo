import { describe, expect, test } from "vitest"
import { Hono } from "hono"
import { DuplicateRouteOwner, createRouteOwnership, mountOwnedRoute, withRouteOwnership } from "./route-ownership"

/**
 * The guard, and the behaviour it exists to make impossible.
 *
 * The second describe block is the important one: it demonstrates on a real
 * Hono app that a duplicate mount does NOT fail, and that which handler wins
 * depends on mount order. Without that demonstration the guard reads as
 * defensive tidiness rather than a fix for something real.
 */

describe("createRouteOwnership", () => {
  test("records who owns each prefix", () => {
    const ownership = createRouteOwnership()

    ownership.claim("/api/workspace", "hosted-core")
    ownership.claim("/api/claxedo/config", "local-execution")

    expect(ownership.owner("/api/workspace")).toBe("hosted-core")
    expect(ownership.mounts()).toEqual([
      { prefix: "/api/claxedo/config", owner: "local-execution" },
      { prefix: "/api/workspace", owner: "hosted-core" },
    ])
  })

  test("refuses a second owner for the same prefix", () => {
    const ownership = createRouteOwnership()
    ownership.claim("/api/claxedo/config", "hosted-core")

    expect(() => ownership.claim("/api/claxedo/config", "local-execution")).toThrow(DuplicateRouteOwner)
  })

  test("names both owners, because the fix needs to know which to remove", () => {
    const ownership = createRouteOwnership()
    ownership.claim("/api/claxedo/config", "hosted-core")

    expect(() => ownership.claim("/api/claxedo/config", "local-execution")).toThrow(/hosted-core.*local-execution/)
  })

  test("allows one owner to mount several route objects under one prefix", () => {
    // The hosted app does this today: workspace routes and checkpoint routes
    // both mount at /api/workspace. That is one owner making one decision, and
    // failing it would break a working composition to enforce a rule about a
    // different problem.
    const ownership = createRouteOwnership()

    ownership.claim("/api/workspace", "hosted-core")

    expect(() => ownership.claim("/api/workspace", "hosted-core")).not.toThrow()
  })

  test("treats nested prefixes as distinct, not as a conflict", () => {
    // `/api/workspace` and `/api/workspace/:id/checkpoints` legitimately
    // coexist. A rule about overlap rather than equality would reject the
    // arrangement the product already ships.
    const ownership = createRouteOwnership()

    ownership.claim("/api/workspace", "hosted-core")

    expect(() => ownership.claim("/api/workspace/:id/checkpoints", "checkpoints")).not.toThrow()
  })
})

describe("what Hono does without the guard", () => {
  test("silently keeps whichever mounted first", async () => {
    // The behaviour being prevented, demonstrated rather than asserted from
    // memory. Two owners, one prefix, no error — and the loser is dead code.
    const app = new Hono()
    app.route("/api/config", new Hono().get("/", (c) => c.text("first")))
    app.route("/api/config", new Hono().get("/", (c) => c.text("second")))

    const response = await app.request("http://test/api/config")

    expect(await response.text()).toBe("first")
  })

  test("and the winner flips when the composition order changes", async () => {
    // This is why it cannot be left to review: reordering two mount calls,
    // with no change to any handler, changes what the app serves.
    const app = new Hono()
    app.route("/api/config", new Hono().get("/", (c) => c.text("second")))
    app.route("/api/config", new Hono().get("/", (c) => c.text("first")))

    expect(await (await app.request("http://test/api/config")).text()).toBe("second")
  })
})

describe("withRouteOwnership", () => {
  test("records every mount without changing routing", async () => {
    const ownership = createRouteOwnership()
    const app = withRouteOwnership(new Hono(), ownership, "hosted-core")

    app.route("/api/workspace", new Hono().get("/", (c) => c.text("ok")) as never)

    expect(await (await app.request("http://test/api/workspace")).text()).toBe("ok")
    expect(ownership.owner("/api/workspace")).toBe("hosted-core")
  })

  test("throws at composition time when two owners collide", () => {
    // At boot, where it is one line of output — not at the first request that
    // happens to reach the losing handler.
    const ownership = createRouteOwnership()
    const app = new Hono()
    withRouteOwnership(app, ownership, "hosted-core").route("/api/claxedo/config", new Hono() as never)

    expect(() =>
      withRouteOwnership(app, ownership, "local-execution").route("/api/claxedo/config", new Hono() as never),
    ).toThrow(DuplicateRouteOwner)
  })

  test("catches a duplicate the shared core and an adapter would both mount", () => {
    // The concrete Unit 7 case: the signed control-plane core and the
    // local-execution adapter are separate compositions that will be combined,
    // and both have a claim on some of these prefixes today.
    const ownership = createRouteOwnership()
    const app = new Hono()
    const core = withRouteOwnership(app, ownership, "signed-control-plane")
    core.route("/api/claxedo/documents", new Hono() as never)

    expect(() =>
      withRouteOwnership(app, ownership, "self-hosted-node").route("/api/claxedo/documents", new Hono() as never),
    ).toThrow(/signed-control-plane.*self-hosted-node/)
  })
})

describe("mountOwnedRoute", () => {
  test("mounts a contribution under its own owner after the core wrapper is installed", async () => {
    const ownership = createRouteOwnership()
    const app = withRouteOwnership(new Hono(), ownership, "core")
    app.route("/api/core", new Hono().get("/", (c) => c.text("core")) as never)

    mountOwnedRoute(
      app,
      ownership,
      "feature:agent-plugins",
      "/api/agent-plugins",
      new Hono().get("/", (c) => c.text("plugins")) as never,
    )

    expect(await (await app.request("/api/agent-plugins")).text()).toBe("plugins")
    expect(ownership.owner("/api/agent-plugins")).toBe("feature:agent-plugins")
  })

  test("rejects a contribution that claims a core prefix", () => {
    const ownership = createRouteOwnership()
    const app = withRouteOwnership(new Hono(), ownership, "core")
    app.route("/api/core", new Hono() as never)

    expect(() => mountOwnedRoute(app, ownership, "feature", "/api/core", new Hono() as never))
      .toThrow(DuplicateRouteOwner)
  })
})
