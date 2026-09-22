import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

import { clampZoomFactor, ZOOM_FACTOR_MAX, ZOOM_FACTOR_MIN } from "./zoom-factor"

describe("zoom factor range", () => {
  test("keeps a factor inside the range", () => {
    expect(clampZoomFactor(1)).toBe(1)
    expect(clampZoomFactor(1.2)).toBe(1.2)
  })

  test("clamps to the range", () => {
    expect(clampZoomFactor(0)).toBe(ZOOM_FACTOR_MIN)
    expect(clampZoomFactor(-3)).toBe(ZOOM_FACTOR_MIN)
    expect(clampZoomFactor(1e9)).toBe(ZOOM_FACTOR_MAX)
    expect(clampZoomFactor(Infinity)).toBe(ZOOM_FACTOR_MAX)
    expect(clampZoomFactor(-Infinity)).toBe(ZOOM_FACTOR_MIN)
  })
})

describe("set-zoom-factor handler wiring", () => {
  const main = path.join(import.meta.dir, "../main")
  const source = readFileSync(path.join(main, "ipc.ts"), "utf8")
  const handler = source.slice(source.indexOf('ipcMain.handle("set-zoom-factor"'), source.indexOf('ipcMain.on("set-native-theme"'))

  test("the handler refuses a non-number and clamps the rest", () => {
    expect(handler).toContain("Number.isFinite(")
    expect(handler).toContain("clampZoomFactor(")
  })

  test("the renderer clamps with the same range", () => {
    const renderer = readFileSync(path.join(import.meta.dir, "../renderer/webview-zoom.ts"), "utf8")
    expect(renderer).toContain("clampZoomFactor(")
    expect(renderer).not.toMatch(/MAX_ZOOM_LEVEL|MIN_ZOOM_LEVEL/)
  })
})
