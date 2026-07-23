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

  test("backs every publishable claim with repository evidence", async () => {
    const repository = new URL("../../../", import.meta.url)
    expect(
      await Promise.all(
        publishableClaims.flatMap((item) => item.evidence).map((evidence) => Bun.file(new URL(evidence, repository)).exists()),
      ),
    ).not.toContain(false)
  })

  test("has a complete release artifact contract", () => {
    expect(downloads.map((download) => download.platform)).toEqual([
      "macos-arm64",
      "macos-x64",
      "windows-x64",
      "linux-deb",
      "linux-rpm",
    ])
    expect(downloads.every((download) => download.href.startsWith("https://github.com/"))).toBe(true)
  })
})
