import type { Locator } from "@playwright/test"

export function uncovered(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const x = box.left + Math.min(box.width / 2, 40)
    return [box.top + 1, box.bottom - 1].every((y) => {
      const hit = document.elementFromPoint(x, y)
      return !!hit && (element.contains(hit) || hit.contains(element))
    })
  })
}
