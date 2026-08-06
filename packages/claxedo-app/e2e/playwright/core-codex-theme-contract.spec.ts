import { expect, test } from "@playwright/test"

test.describe("Codex theme contract @core", () => {
  test("ring and shadow composition stays valid for every enabled combination", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("opencode-theme-id", "codex")
      localStorage.setItem("opencode-color-scheme", "dark")
    })
    await page.goto("/demo/index.html")
    await expect(page.locator("html")).toHaveAttribute("data-theme", "codex")

    const result = await page.evaluate(() => {
      const styles = getComputedStyle(document.documentElement)
      const ring = styles.getPropertyValue("--elevation-ring-overlay").trim()
      const shadow = styles.getPropertyValue("--elevation-shadow-overlay").trim()
      const disabled = "0 0 #0000"

      return {
        ring,
        shadow,
        combinations: [
          [ring, disabled],
          [disabled, shadow],
          [ring, shadow],
          [disabled, disabled],
        ].map(([nextRing, nextShadow]) => {
          const probe = document.createElement("div")
          probe.style.setProperty("--theme-test-ring", nextRing)
          probe.style.setProperty("--theme-test-shadow", nextShadow)
          probe.style.boxShadow = "var(--theme-test-ring), var(--theme-test-shadow)"
          document.body.append(probe)
          const value = getComputedStyle(probe).boxShadow
          probe.remove()
          return value
        }),
      }
    })

    expect(result.ring).not.toBe("")
    expect(result.shadow).not.toBe("")
    expect(result.combinations).toHaveLength(4)
    for (const value of result.combinations) {
      expect(value).not.toBe("")
      expect(value).not.toBe("none")
    }
  })
})
