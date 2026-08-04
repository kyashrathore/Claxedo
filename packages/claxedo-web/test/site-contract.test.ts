import { describe, expect, test } from "bun:test"
import { claims, publishableClaims } from "../src/content/claims"
import { marketingActions, publicOrigin, routes } from "../src/content/routes"
import { approvedMarketingActions, site } from "../src/content/site"
import { downloads } from "../src/config"

describe("public site contract", () => {
  test("has exactly two canonical marketing actions", () => {
    expect(approvedMarketingActions).toEqual([marketingActions.cloud, marketingActions.deploy])
    expect(marketingActions.cloud.href).toBe(routes.app)
    expect(marketingActions.deploy.href).toBe(routes.deploy)
  })

  test("keeps the product hierarchy and canonical origin stable", () => {
    expect(site.product.name).toBe("Claxedo")
    expect(site.clients.desktop.name).toBe("Claxedo Desktop")
    expect(site.clients.web.name).toBe("Claxedo Web")
    expect(site.framework.name).toBe("Claxedo Framework")
    expect(new URL(publicOrigin).origin).toBe(publicOrigin)
  })

  test("withholds claims without evidence", () => {
    expect(claims.some((item) => item.status === "withheld")).toBe(true)
    expect(publishableClaims.every((item) => item.evidence.length > 0 && item.verifiedAt)).toBe(true)
    expect(publishableClaims.map((item) => item.id as string)).not.toContain("hosted-source-parity")
  })

  test("has a complete release artifact contract", () => {
    // Mirrors release-claxedo.yml's five build legs × electron-builder targets:
    // mac arm64/x64 (dmg), win x64 (nsis), linux x64+arm64 (AppImage/deb/rpm).
    expect(downloads.map((download) => download.platform)).toEqual([
      "macos-arm64",
      "macos-x64",
      "windows-x64",
      "linux-appimage",
      "linux-deb",
      "linux-rpm",
      "linux-arm64-appimage",
      "linux-arm64-deb",
      "linux-arm64-rpm",
    ])
    expect(downloads.every((download) => download.href.startsWith("https://github.com/"))).toBe(true)
  })
})
