import { describe, expect, test } from "bun:test"
import { createProductContributions } from "./product-contributions"
import { HostedContributionError } from "@/platform/account/hosted-contribution-port"
import type { AccountState } from "@/platform/account/account-port"
import type { ContentSurfaceContribution } from "../integrations/content-surface-contract"

const SIGNED: AccountState = { status: "signed", identity: { userId: "user_1" } }
const UNSIGNED: AccountState = { status: "unsigned" }

function surface(id: string, type: string): ContentSurfaceContribution {
  return { id, tier: "claxedo-first-party", surface: type, slot: "workbench", renderer: () => null }
}

/**
 * A composition with a real registry behind it, so every test reads what the
 * registry ended up holding rather than what the composition reported.
 */
function composition(options: {
  local?: readonly ContentSurfaceContribution[]
  hosted?: () => Promise<readonly ContentSurfaceContribution[]>
  hostedComposition?: boolean
} = {}) {
  const registered = (options.local ?? []).map((item) => item.id)
  const hostedComposition = options.hostedComposition ?? true
  let loads = 0

  const contributions = createProductContributions({
    local: options.local ?? [],
    register: (item) => registered.push(item.id),
    unregister: (item) => {
      const index = registered.indexOf(item.id)
      if (index !== -1) registered.splice(index, 1)
    },
    loadHosted: async () => {
      loads += 1
      return {
        contentSurfaces: options.hosted
          ? await options.hosted()
          : [surface("surface.content.workgraph", "workgraph")],
      }
    },
    hostedComposition: () => hostedComposition,
  })

  return { contributions, registered, loads: () => loads }
}

describe("product contributions", () => {
  test("a local composition exposes only local content types", () => {
    const app = composition({ local: [surface("surface.content.session", "session")] })

    expect(app.contributions.hostedExpected()).toBe(false)
    expect(app.contributions.hostedActive()).toBe(false)
    expect(app.contributions.availableContentTypes()).toEqual(["session"])
  })

  test("expecting hosted widens the available types before anything loads", () => {
    // The whole reason `expectHosted` is separate from `activateHosted`.
    // Restored-state pruning runs synchronously; if it asked "is hosted
    // registered yet" it would delete every WorkGraph tab in the window before
    // the dynamic import resolves.
    const app = composition({ local: [surface("surface.content.session", "session")] })

    app.contributions.expectHosted()

    expect(app.contributions.hostedExpected()).toBe(true)
    expect(app.contributions.hostedActive()).toBe(false)
    expect(app.contributions.availableContentTypes()).toContain("workgraph")
    expect(app.contributions.availableContentTypes()).toContain("page")
  })

  test("registers the hosted set once, however many callers race", async () => {
    // Sign-in and a route needing a hosted surface can fire in either order.
    // Registering twice throws on the second pass rather than no-opping, so
    // "once" has to be enforced rather than hoped for.
    const app = composition({ local: [surface("surface.content.session", "session")] })

    await Promise.all([
      app.contributions.activateHosted(),
      app.contributions.activateHosted(),
      app.contributions.activateHosted(),
    ])

    expect(app.loads()).toBe(1)
    expect(app.registered).toEqual(["surface.content.session", "surface.content.workgraph"])
    expect(app.contributions.hostedActive()).toBe(true)
  })

  test("activating hosted widens the available types too", async () => {
    // A caller that reaches `activateHosted` without `expectHosted` has still
    // declared this composition hosted; pruning must not disagree with the
    // registry.
    const app = composition()

    await app.contributions.activateHosted()

    expect(app.contributions.hostedExpected()).toBe(true)
    expect(app.contributions.availableContentTypes()).toContain("workgraph")
  })

  test("rejects a hosted contribution that would shadow a local one", async () => {
    const app = composition({
      local: [surface("surface.content.session", "session")],
      hosted: async () => [surface("surface.content.session", "session")],
    })

    const error = await app.contributions.activateHosted().then(
      () => expect.unreachable("a shadowing surface must be refused"),
      (reason: unknown) => reason as HostedContributionError,
    )

    expect(error).toBeInstanceOf(HostedContributionError)
    expect(error.code).toBe("shadows_registered_contribution")
    // All-or-nothing: a partially registered hosted set is a composition with
    // some surfaces present and some missing, which is harder to diagnose than
    // a failure.
    expect(app.registered).toEqual(["surface.content.session"])
  })

  test("registers nothing when any hosted contribution conflicts", async () => {
    const app = composition({
      local: [surface("surface.content.session", "session")],
      hosted: async () => [
        surface("surface.content.workgraph", "workgraph"),
        surface("surface.content.session", "session"),
      ],
    })

    await app.contributions.activateHosted().catch(() => {})

    expect(app.registered).toEqual(["surface.content.session"])
  })
})

describe("hosted activation failure and duplicate handling", () => {
  test("a failed activation can be retried", async () => {
    // The caching bug this covers: keeping the REJECTED promise disabled
    // hosted mode for the life of the window, so one transient chunk-load
    // failure left a signed user in a local-only app until they reloaded.
    let attempts = 0
    const app = composition({
      hosted: async () => {
        attempts++
        if (attempts === 1) throw new Error("chunk load failed")
        return [surface("surface.content.workgraph", "workgraph")]
      },
    })

    await expect(app.contributions.activateHosted()).rejects.toThrow(/chunk load failed/)

    await app.contributions.activateHosted()

    expect(attempts).toBe(2)
    expect(app.registered).toEqual(["surface.content.workgraph"])
  })

  test("two hosted contributions sharing an id are rejected, and nothing registers", async () => {
    // The previous check compared every hosted surface against the LOCAL ids
    // before adding any of them, so a collision between two HOSTED surfaces
    // passed and the second silently overwrote the first — the destination
    // reordering stable ids exist to prevent.
    const app = composition({
      hosted: async () => [surface("surface.content.page", "page"), surface("surface.content.page", "pages-index")],
    })

    const error = await app.contributions.activateHosted().then(
      () => expect.unreachable("duplicate ids must be rejected"),
      (reason: unknown) => reason as HostedContributionError,
    )

    // On the CODE, not the message. The message is prose that may be reworded;
    // the code is what a caller branches on, and it distinguishes a set that
    // collides with this build from a set that is internally inconsistent.
    expect(error.code).toBe("duplicate_contribution_id")
    expect(app.registered).toEqual([])
  })
})

describe("hosted contributions follow the account", () => {
  test("signing out removes the hosted surfaces, leaving the local ones", async () => {
    // The defect: before deactivation existed, hosted surfaces stayed
    // registered for the life of the window, so a signed-out app kept
    // rendering WorkGraph and Documents until the page reloaded.
    const app = composition({ local: [surface("surface.content.session", "session")] })

    await app.contributions.activateHosted()
    app.contributions.followAccount(SIGNED)
    expect(app.registered).toEqual(["surface.content.session", "surface.content.workgraph"])

    app.contributions.followAccount(UNSIGNED)

    expect(app.registered).toEqual(["surface.content.session"])
    expect(app.contributions.hostedActive()).toBe(false)
  })

  test("signing back in restores them without loading the bundle again", async () => {
    const app = composition()

    app.contributions.followAccount(SIGNED)
    await app.contributions.activateHosted()
    app.contributions.followAccount(UNSIGNED)
    app.contributions.followAccount(SIGNED)
    await app.contributions.activateHosted()

    expect(app.loads()).toBe(1)
    expect(app.registered).toEqual(["surface.content.workgraph"])
  })

  test("a window that never signed in keeps the surfaces its BUILD composed", async () => {
    // The asymmetry, and the reason `followAccount` is not
    // `signed ? activate : deactivate`. A hosted build activates at boot and
    // serves unsigned windows — the loopback E2E lane is exactly that — so an
    // account that has never been signed must not empty the composition.
    const app = composition({ local: [surface("surface.content.session", "session")] })

    await app.contributions.activateHosted()
    app.contributions.followAccount(UNSIGNED)
    app.contributions.followAccount(UNSIGNED)

    expect(app.registered).toEqual(["surface.content.session", "surface.content.workgraph"])
    expect(app.contributions.hostedActive()).toBe(true)
  })

  test.each([
    ["pending", { status: "pending" } as AccountState],
    ["unavailable", { status: "unavailable", reason: "no-secure-storage" } as AccountState],
  ])("removes them for a %s account, the same as an unsigned one", async (_label, state) => {
    // Only `signed` keeps them. "Sign-in is in flight" and "signed mode cannot
    // work on this machine" are both windows without an account, and leaving
    // hosted surfaces registered in either is the same defect.
    const app = composition()

    await app.contributions.activateHosted()
    app.contributions.followAccount(SIGNED)
    app.contributions.followAccount(state)

    expect(app.registered).toEqual([])
    expect(app.contributions.hostedActive()).toBe(false)
  })

  test("a local composition refuses to activate hosted contributions at all", async () => {
    // `hostedComposition` false is the local build: no hosted set, whatever an
    // account reports. The loader is never even reached.
    const app = composition({ hostedComposition: false })

    await expect(app.contributions.activateHosted()).rejects.toThrow(HostedContributionError)
    app.contributions.followAccount(SIGNED)

    expect(app.loads()).toBe(0)
    expect(app.registered).toEqual([])
  })
})
