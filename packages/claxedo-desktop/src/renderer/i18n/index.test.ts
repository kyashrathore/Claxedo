import { describe, expect, test } from "bun:test"
import { loadDesktopDictionary } from "./index"

describe("desktop locale loading", () => {
  test("keeps English available synchronously and loads a non-English pair on demand", async () => {
    const english = await loadDesktopDictionary("en")
    expect(english["desktop.menu.restart"]).toBe("Restart")

    const first = loadDesktopDictionary("de")
    const second = loadDesktopDictionary("de")
    expect(second).toBe(first)

    const german = await first
    expect(german["desktop.menu.restart"]).toBe("Neustart")
    // The selected app dictionary and desktop overlay are loaded as one unit.
    expect(german["command.category.view"]).not.toBe(english["command.category.view"])
  })

  test("resolves every advertised non-English dictionary chunk", async () => {
    const locales = ["zh", "zht", "ko", "de", "es", "fr", "da", "ja", "pl", "ru", "ar", "no", "br", "bs"] as const
    for (const locale of locales) {
      const dict = await loadDesktopDictionary(locale)
      expect(typeof dict["desktop.menu.restart"]).toBe("string")
      expect(typeof dict["command.category.view"]).toBe("string")
    }
  })
})
