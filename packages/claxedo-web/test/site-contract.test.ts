import { describe, expect, test } from "bun:test"
import { claims, publishableClaims } from "../src/content/claims"
import { marketingActions, publicOrigin, routes } from "../src/content/routes"
import { approvedMarketingActions, home, macDownload, site } from "../src/content/site"
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

  test("binds every home page block to publishable claims", () => {
    expect(site.description).toContain("Claude Code, Codex, Cursor, OpenCode, Pi and any ACP agent")
    expect(home.benchmark.metrics.map((metric) => metric.label)).toEqual(["faster start", "faster session open", "faster return", "less memory", "idle CPU"])
    expect(home.rows.map((row) => row.id)).toEqual(["prompt", "cloudflare", "sandbox", "plugins", "terminal"])
    const publishable = new Set<string>(publishableClaims.map((item) => item.id))
    const blocks = [home.hero, home.benchmark, ...home.rows, home.closing]
    for (const block of blocks) {
      expect(block.claims.length).toBeGreaterThan(0)
      for (const id of block.claims) expect(publishable.has(id)).toBe(true)
    }
  })

  test("downloads the Apple Silicon build from the macOS pill", () => {
    expect(macDownload.platform).toBe("macos-arm64")
    expect(macDownload.href).toEndWith("claxedo-desktop-mac-arm64.dmg")
  })

  test("cites evidence that exists in the repository", async () => {
    const repositoryFiles = publishableClaims.flatMap((item) => item.evidence).filter((path) => !path.startsWith("https://"))
    const missing = []
    for (const path of repositoryFiles) {
      if (!(await Bun.file(new URL(`../../../${path}`, import.meta.url)).exists())) missing.push(path)
    }
    expect(missing).toEqual([])
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
