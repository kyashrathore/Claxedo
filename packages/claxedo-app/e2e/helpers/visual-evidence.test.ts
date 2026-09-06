// Unit coverage for `comparePng` and the path helpers. Plain `bun:test`, no browser:
// `comparePng` only touches files via `sharp`.
//
// The dot fixtures are hand-built pixel buffers, not app screenshots. They prove that
// `comparePng` catches a small purely-positional shift, not that any product screen is
// pixel-correct.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"
import { comparePng, evidencePath, goldenPath, parseEvidenceRelativePath } from "./visual-evidence"

const WIDTH = 48
const HEIGHT = 16
const DOT_SIZE = 6
// Two dot x-offsets a few pixels apart.
const FIXED_DOT_X = 11
const BROKEN_DOT_X = 6

/** A WIDTH x HEIGHT white canvas with a black `DOT_SIZE` square at x-offset `dotX`, vertically centered. */
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

describe("comparePng", () => {
  test("a shifted dot produces a non-zero diff", async () => {
    const result = await comparePng(brokenPath, fixedPath, { diffPath: null })
    expect(result.diffPixels).toBeGreaterThan(0)
    expect(result.diffRatio).toBeGreaterThan(0)
    // Only the dot's footprint can differ; "everything differs" is as wrong as "nothing differs".
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
