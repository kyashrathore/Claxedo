import { describe, expect, test } from "bun:test"
import { deriveDevIdentity, tintBitmap } from "./dev-identity-policy"

describe("dev worktree identity", () => {
  test("the main checkout keeps the unlabeled dev identity", () => {
    expect(deriveDevIdentity(null)).toEqual({
      label: null,
      name: "Claxedo Dev",
      userDataSuffix: "",
      hue: null,
    })
  })

  test("a worktree label names, suffixes, and colors the build deterministically", () => {
    const first = deriveDevIdentity("codex/goal-mode")
    expect(first.name).toBe("Claxedo Dev (codex/goal-mode)")
    expect(first.userDataSuffix).toBe(".codex-goal-mode")
    expect(first.hue).toBeGreaterThanOrEqual(0)
    expect(first.hue).toBeLessThan(360)
    // Same label → same identity; different label → different hue is expected
    // for these two names (guards the hash actually varying, not a rainbow).
    expect(deriveDevIdentity("codex/goal-mode")).toEqual(first)
    expect(deriveDevIdentity("boundary-policy").hue).not.toBe(first.hue)
  })

  test("tinting keeps alpha and produces the hue-scaled channels", () => {
    // One opaque white pixel and one transparent pixel, BGRA.
    const bitmap = Buffer.from([255, 255, 255, 255, 0, 0, 0, 0])
    const out = tintBitmap(Buffer.from(bitmap), 0)
    expect(out[3]).toBe(255)
    expect(out[7]).toBe(0)
    // Hue 0 is red-dominant: R > G and R > B at full luminance.
    expect(out[2]!).toBeGreaterThan(out[1]!)
    expect(out[2]!).toBeGreaterThan(out[0]!)
  })
})
