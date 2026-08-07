import { describe, expect, test } from "bun:test"
import { createProductContributions, ProductContributionError } from "./product-contributions"
import type { ContentSurfaceContribution } from "../integrations/content-surface-contract"

function surface(id: string, type: string): ContentSurfaceContribution {
  return { id, tier: "claxedo-first-party", surface: type, slot: "workbench", renderer: () => null }
}

describe("product contributions", () => {
  test("a local composition exposes only local content types", () => {
    const contributions = createProductContributions({
      local: [surface("surface.content.session", "session")],
      register: () => {},
    })

    expect(contributions.hostedExpected()).toBe(false)
    expect(contributions.hostedActive()).toBe(false)
    expect(contributions.availableContentTypes()).toEqual(["session"])
  })

  test("expecting hosted widens the available types before anything loads", () => {
    // The whole reason `expectHosted` is separate from `activateHosted`.
    // Restored-state pruning runs synchronously; if it asked "is hosted
    // registered yet" it would delete every WorkGraph tab in the window before
    // the dynamic import resolves.
    const contributions = createProductContributions({
      local: [surface("surface.content.session", "session")],
      register: () => {},
    })

    contributions.expectHosted()

    expect(contributions.hostedExpected()).toBe(true)
    expect(contributions.hostedActive()).toBe(false)
    expect(contributions.availableContentTypes()).toContain("workgraph")
    expect(contributions.availableContentTypes()).toContain("page")
  })

  test("registers the hosted set once, however many callers race", async () => {
    // Sign-in and a route needing a hosted surface can fire in either order.
    // Registering twice throws on the second pass rather than no-opping, so
    // "once" has to be enforced here rather than hoped for.
    const registered: string[] = []
    let loads = 0
    const contributions = createProductContributions({
      local: [surface("surface.content.session", "session")],
      register: (item) => registered.push(item.id),
    })
    const loader = async () => {
      loads += 1
      return { contentSurfaces: [surface("surface.content.workgraph", "workgraph")] }
    }

    await Promise.all([
      contributions.activateHosted(loader),
      contributions.activateHosted(loader),
      contributions.activateHosted(loader),
    ])

    expect(loads).toBe(1)
    expect(registered).toEqual(["surface.content.workgraph"])
    expect(contributions.hostedActive()).toBe(true)
  })

  test("rejects a hosted contribution that would shadow a local one", async () => {
    const contributions = createProductContributions({
      local: [surface("surface.content.session", "session")],
      register: () => {},
    })

    await expect(
      contributions.activateHosted(async () => ({
        contentSurfaces: [surface("surface.content.session", "session")],
      })),
    ).rejects.toThrow(ProductContributionError)
  })

  test("registers nothing when any hosted contribution conflicts", async () => {
    // All-or-nothing: a partially registered hosted set is a composition with
    // some surfaces present and some missing, which is harder to diagnose than
    // a failure.
    const registered: string[] = []
    const contributions = createProductContributions({
      local: [surface("surface.content.session", "session")],
      register: (item) => registered.push(item.id),
    })

    await contributions
      .activateHosted(async () => ({
        contentSurfaces: [surface("surface.content.workgraph", "workgraph"), surface("surface.content.session", "session")],
      }))
      .catch(() => {})

    expect(registered).toEqual([])
  })
})
