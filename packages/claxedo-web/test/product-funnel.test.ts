import { describe, expect, test } from "bun:test"
import { downloads } from "../src/config"
import { marketingActions } from "../src/content/routes"

describe("commercial funnel", () => {
  test("implements the approved CTA contract", () => {
    expect(marketingActions.download.href).toBe("/download#releases")
    expect(marketingActions.framework.href).toBe("/framework")
    // Download and framework are the only CTAs the site renders. Asserting the
    // exact key set keeps a re-added action from silently reviving a dead
    // conversion event name in analytics.ts.
    expect(Object.keys(marketingActions).sort()).toEqual(["download", "framework"])
    expect(downloads).toHaveLength(9)
    expect(downloads.every((download) => download.platform && download.href)).toBe(true)
  })
})
