import { describe, expect, test } from "bun:test"
import { claims, publishableClaims } from "../src/content/claims"
import { marketingActions, publicOrigin, routes } from "../src/content/routes"
import { approvedMarketingActions, site } from "../src/content/site"
import { downloads } from "../src/config"

describe("public site contract", () => {
  test("has exactly one canonical marketing action", () => {
    expect(approvedMarketingActions).toEqual([marketingActions.download])
    expect(marketingActions.download.href).toBe(`${routes.download}#releases`)
  })

  test("keeps the product hierarchy and canonical origin stable", () => {
    expect(site.product.name).toBe("Claxedo")
    expect(site.clients.desktop.name).toBe("Claxedo Desktop")
    expect(site.clients.web.name).toBe("Claxedo Web")
    expect(new URL(publicOrigin).origin).toBe(publicOrigin)
  })

  test("leads with the differentiated workspace story", () => {
    expect(site.headline).toBe("Your coding agents, finally in one place.")
    expect(site.hero.lead).toContain("Bring any sandbox")
    expect(site.hero.lead).toContain("skills, MCP servers, plugins, and credentials")
    expect(site.hero.proof).toEqual(["Performance-first", "Any sandbox provider", "Chat + terminal"])
    expect(site.hero.costNote).toContain("usage and connected services are separate")
    expect(site.focusSections.map((section) => section.id)).toEqual([
      "performance",
      "sandboxes",
      "chat",
      "terminal",
      "control-plane",
    ])
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
