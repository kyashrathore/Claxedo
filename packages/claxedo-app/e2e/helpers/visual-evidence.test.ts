// Unit coverage for `visual-evidence.ts`'s pure pixel-diff (`comparePng`) and path
// helpers. Style/runner matches `e2e/bun/workspace-relay-connection.test.ts` — plain
// `bun:test`, no Playwright, no browser — because `comparePng` has no Page dependency at
// all; it only touches files on disk via `sharp`.
//
// PROXY, NOT PRODUCT-LEVEL PROOF — read this before trusting what it claims. The plan's
// Phase 5 load-bearing requirement is: "moving the rail dot back to `left-1.5` (defect
// 11) must produce a non-zero diff." This test does NOT drive the real app, does NOT
// screenshot a real rail row, and does NOT revert `navigation-row.tsx`'s actual fix (this
// agent owns only `e2e/helpers/visual-evidence.ts` and `scripts/visual-adjudicate.ts` —
// touching product code or another agent's spec file is out of scope, see the task's HARD
// RULES). What it DOES prove is narrower and mechanical: `comparePng` is capable of
// catching a small, purely-positional pixel shift — the exact shape of defect 11
// (`e2e/helpers/geometry-oracle.ts`'s header: the dot "previously rendered ... at
// `left-1.5` outside any glyph column at all" vs. the fixed in-glyph-column position) —
// rather than only catching gross content changes. The two synthetic fixtures below are
// NOT captured from the app; they are hand-built pixel buffers with a small square "dot"
// painted at two different x-offsets, standing in for "golden" (fixed geometry) and
// "actual" (regressed geometry). The real, product-level proof — golden.png captured from
// a working rail row, actual.png captured after literally reverting the fix — is Phase
// 2/4/5 CI wiring's job once goldens exist; this test is the narrowest thing that can be
// proven from two owned files with no product-code access.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"
import { comparePng, evidencePath, goldenPath, parseEvidenceRelativePath } from "./visual-evidence"

const WIDTH = 48
const HEIGHT = 16
const DOT_SIZE = 6
// Fixed-geometry x-offset — arbitrary but distinct from BROKEN_DOT_X; stands in for the
// dot rendered inside its glyph column (the fix).
const FIXED_DOT_X = 11
// `left-1.5` = 0.375rem = 6px at the default 16px root font-size — the literal broken
// value geometry-oracle.ts's header comment names for defect 11.
const BROKEN_DOT_X = 6

/** Paints a WIDTH x HEIGHT white canvas with a solid black `DOT_SIZE`-square "status dot"
 * at horizontal offset `dotX`, vertically centered — a synthetic stand-in for the rail's
 * status-dot glyph, not a real screenshot. */
async function renderDotFixture(dotX: number): Promise<Buffer> {
  const channels = 4
  const buffer = Buffer.alloc(WIDTH * HEIGHT * channels, 255) // opaque white
  const dotY = Math.floor((HEIGHT - DOT_SIZE) / 2)
  for (let y = dotY; y < dotY + DOT_SIZE; y++) {
    for (let x = dotX; x < dotX + DOT_SIZE; x++) {
      const offset = (y * WIDTH + x) * channels
      buffer[offset] = 0
      buffer[offset + 1] = 0
      buffer[offset + 2] = 0
      buffer[offset + 3] = 255
    }
  }
  return sharp(buffer, { raw: { width: WIDTH, height: HEIGHT, channels } }).png().toBuffer()
}

let workDir: string
let fixedPath: string
let brokenPath: string
let fixedCopyPath: string

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "claxedo-visual-evidence-test-"))
  fixedPath = join(workDir, "golden-fixed-dot.png")
  brokenPath = join(workDir, "actual-broken-dot.png")
  fixedCopyPath = join(workDir, "golden-fixed-dot-copy.png")
  await Bun.write(fixedPath, await renderDotFixture(FIXED_DOT_X))
  await Bun.write(brokenPath, await renderDotFixture(BROKEN_DOT_X))
  // Byte-identical copy of the golden — the negative control. If this ever reports a
  // non-zero diff, comparePng itself is broken (false positive), not the dot-shift case.
  await Bun.write(fixedCopyPath, await renderDotFixture(FIXED_DOT_X))
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe("comparePng — proxy for defect 11 (rail dot geometry)", () => {
  test("a shifted dot (defect 11's left-1.5 regression, proxied) produces a non-zero diff", async () => {
    const result = await comparePng(brokenPath, fixedPath, { diffPath: null })
    expect(result.diffPixels).toBeGreaterThan(0)
    expect(result.diffRatio).toBeGreaterThan(0)
    // Sanity bound: only the dot's footprint (and the sliver it vacated/entered) can
    // differ between two otherwise-identical canvases — never the whole image. This
    // catches a comparePng that degenerates to "everything differs" as loudly as it
    // catches "nothing differs".
    expect(result.diffPixels).toBeLessThan(WIDTH * HEIGHT)
  })

  test("positive control: an identical image diffs to exactly zero", async () => {
    const result = await comparePng(fixedCopyPath, fixedPath, { diffPath: null })
    expect(result.diffPixels).toBe(0)
    expect(result.diffRatio).toBe(0)
  })

  test("dimension mismatch is reported as maximally different, not a crash", async () => {
    const wider = join(workDir, "wider.png")
    await Bun.write(
      wider,
      await sharp(Buffer.alloc((WIDTH + 8) * HEIGHT * 4, 255), { raw: { width: WIDTH + 8, height: HEIGHT, channels: 4 } })
        .png()
        .toBuffer(),
    )
    const result = await comparePng(wider, fixedPath, { diffPath: null })
    expect(result.diffPixels).toBe(Number.POSITIVE_INFINITY)
    expect(result.diffRatio).toBe(1)
    expect(result.diffPath).toBeNull()
  })

  test("comparePng writes a diff visualization when a diffPath is requested (default derivation)", async () => {
    const result = await comparePng(brokenPath, fixedPath)
    expect(result.diffPath).toBe(brokenPath.replace(/\.png$/, ".diff.png"))
    expect(await Bun.file(result.diffPath!).exists()).toBe(true)
  })
})

describe("evidence/golden path helpers", () => {
  test("evidencePath and goldenPath share the <spec>/<scenario>.png shape at different roots", () => {
    const evidence = { spec: "desktop-unsigned-embedded", scenario: "rail-row-visible" }
    expect(evidencePath(evidence, "/repo")).toBe("/repo/test-results/evidence/desktop-unsigned-embedded/rail-row-visible.png")
    expect(goldenPath(evidence, "/repo")).toBe("/repo/e2e/goldens/desktop-unsigned-embedded/rail-row-visible.png")
  })

  test("parseEvidenceRelativePath recovers {spec, scenario} and rejects diff/non-PNG files", () => {
    expect(parseEvidenceRelativePath("desktop-unsigned-embedded/rail-row-visible.png")).toEqual({
      spec: "desktop-unsigned-embedded",
      scenario: "rail-row-visible",
    })
    expect(parseEvidenceRelativePath("desktop-unsigned-embedded/rail-row-visible.diff.png")).toBeNull()
    expect(parseEvidenceRelativePath("desktop-unsigned-embedded/rail-row-visible.visual-verdict.json")).toBeNull()
    expect(parseEvidenceRelativePath("not-nested.png")).toBeNull()
  })
})
