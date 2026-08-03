import { describe, expect, test } from "bun:test"
import { downloads } from "../src/config"
import { marketingActions } from "../src/content/routes"

describe("commercial funnel", () => {
  test("implements the approved CTA contract", () => {
    expect(marketingActions.cloud.href).toBe("https://app.claxedo.com")
    expect(marketingActions.deploy.href).toBe("/framework/deploy/cloudflare-full-stack")
    expect(marketingActions.download.href).toBe("/download#releases")
    expect(marketingActions.framework.href).toBe("/framework")
    expect(downloads).toHaveLength(5)
    expect(downloads.every((download) => download.platform && download.href)).toBe(true)
  })
})
