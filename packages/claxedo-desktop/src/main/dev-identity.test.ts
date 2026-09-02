import { describe, expect, test } from "bun:test"
import { deriveDevIdentity, gitHeadLabel, tintBitmap } from "./dev-identity-policy"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("dev worktree identity", () => {
  test("no label keeps the unlabeled dev identity", () => {
    expect(deriveDevIdentity({ label: null, isolateProfile: false })).toEqual({
      label: null,
      name: "Claxedo Dev",
      userDataSuffix: "",
      hue: null,
    })
  })

  test("a worktree label names, isolates, and colors the build deterministically", () => {
    const first = deriveDevIdentity({ label: "codex/goal-mode", isolateProfile: true })
    expect(first.name).toBe("Claxedo Dev (codex/goal-mode)")
    expect(first.userDataSuffix).toBe(".codex-goal-mode")
    expect(first.hue).toBeGreaterThanOrEqual(0)
    expect(first.hue).toBeLessThan(360)
    // Same label → same identity; these two labels must land on different hues
    // (guards the hash actually varying, not a rainbow).
    expect(deriveDevIdentity({ label: "codex/goal-mode", isolateProfile: true })).toEqual(first)
    expect(deriveDevIdentity({ label: "boundary-policy", isolateProfile: true }).hue).not.toBe(first.hue)
  })

  test("a branch label on the main checkout names and colors WITHOUT isolating the profile", () => {
    const identity = deriveDevIdentity({ label: "dev", isolateProfile: false })
    expect(identity.name).toBe("Claxedo Dev (dev)")
    expect(identity.userDataSuffix).toBe("")
    expect(identity.hue).not.toBeNull()
  })

  test("reads the branch from a symbolic HEAD and the short commit from a detached one", () => {
    const dir = mkdtempSync(join(tmpdir(), "dev-identity-"))
    const head = join(dir, "HEAD")
    writeFileSync(head, "ref: refs/heads/chore/remove-local-ui-extensions\n")
    expect(gitHeadLabel(head)).toBe("chore/remove-local-ui-extensions")
    writeFileSync(head, "34cca15f58aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n")
    expect(gitHeadLabel(head)).toBe("34cca15f")
    expect(gitHeadLabel(join(dir, "missing"))).toBeNull()
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
