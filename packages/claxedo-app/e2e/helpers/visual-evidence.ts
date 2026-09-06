// Visual pipeline, mechanical half: writes evidence PNGs to
// `test-results/evidence/<spec>/<scenario>.png` and diffs two PNGs by raw pixel bytes.
// Judgement (which diffs matter, when to ask a vision reviewer) lives in
// `e2e/visual-adjudicate.ts`; a pixel-exact match never reaches it.
//
// The path shape duplicates `turn-oracle.ts`'s private `evidencePath` on purpose: both must
// resolve to the same tree so `visual-adjudicate.ts` walks turn and rail evidence alike.
// Evidence is per-run and gitignored (`test-results/`); goldens are the tracked reference
// images under `e2e/goldens/`.
import type { Page } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import sharp from "sharp"

export type Evidence = {
  /** Spec basename, e.g. "desktop-unsigned-embedded" (no directory, no .spec.ts). */
  spec: string
  /** Scenario slug, e.g. "rail-row-visible". Filesystem-safe, no path separators. */
  scenario: string
}

export type PixelDiffResult = {
  /** Count of pixels differing in ANY channel (R/G/B/A), exact byte compare — no
   * anti-aliasing tolerance. `Infinity` means the two images aren't even the same
   * dimensions, so no pixel count is meaningful. */
  diffPixels: number
  /** `diffPixels / totalPixels`, or `1` for a dimension mismatch (can't be pixel-counted
   * at all — treated as maximally different, not as "0 shared pixels out of 0"). */
  diffRatio: number
  /** Where the visualized diff PNG was written, or `null` when no diff image was
   * requested/possible (dimension mismatch — there's no meaningful pixel-aligned overlay
   * to draw when the two images aren't the same shape). */
  diffPath: string | null
  /** Present only when both images share dimensions — omitted (not zeroed) on a
   * mismatch so a caller can't mistake "0x0" for "these happen to be square". */
  width?: number
  height?: number
}

export type ComparePngOptions = {
  /** Where to write the red-highlight diff visualization. Defaults to `actualPath` with
   * its trailing `.png` swapped for `.diff.png`. Pass `null` to skip writing a diff image
   * (e.g. a pixel-exact fast path that doesn't need one — see
   * `e2e/visual-adjudicate.ts`'s zero-diff branch). */
  diffPath?: string | null
}

/** The package root, assuming invocation from `packages/claxedo-app` (as `turn-oracle.ts` assumes). */
function packageRoot() {
  return process.cwd()
}

function ensureDir(filePath: string) {
  mkdirSync(dirname(filePath), { recursive: true })
}

/** `test-results/evidence/<spec>/<scenario>.png`. */
export function evidencePath(evidence: Evidence, root: string = packageRoot()): string {
  return join(root, "test-results", "evidence", evidence.spec, `${evidence.scenario}.png`)
}

/** The tracked reference image a run's evidence is diffed against; updated only via
 * `e2e/visual-adjudicate.ts --update-goldens`. */
export function goldenPath(evidence: Evidence, root: string = packageRoot()): string {
  return join(root, "e2e", "goldens", evidence.spec, `${evidence.scenario}.png`)
}

function defaultDiffPath(actualPath: string): string {
  return actualPath.replace(/\.png$/i, ".diff.png")
}

/**
 * Inverse of `evidencePath`/`goldenPath`: given a path RELATIVE to the evidence (or
 * golden) root — e.g. `"desktop-unsigned-embedded/rail-row-visible.png"`, as produced by
 * walking the tree with a glob — recovers `{spec, scenario}`. Returns `null` for anything
 * that isn't a bare `<spec>/<scenario>.png` two-segment shape, which is how
 * `e2e/visual-adjudicate.ts` skips `*.diff.png` and any stray non-PNG file (verdict
 * JSON, `.DS_Store`, …) without a second exclusion list to keep in sync with this one.
 */
export function parseEvidenceRelativePath(relativePath: string): Evidence | null {
  const parts = relativePath.split(/[\\/]/).filter(Boolean)
  if (parts.length !== 2) return null
  const [spec, file] = parts
  if (!file.toLowerCase().endsWith(".png") || file.toLowerCase().endsWith(".diff.png")) return null
  const scenario = file.slice(0, -".png".length)
  if (!spec || !scenario) return null
  return { spec, scenario }
}

/**
 * Writes one scenario's evidence PNG and returns its absolute path. `turn-oracle.ts` has a
 * private equivalent for assistant-reply proofs; every other oracle calls this one.
 */
export async function captureEvidence(params: {
  page: Page
  spec: string
  scenario: string
  /** Override for tests of this module itself; production callers omit it. */
  root?: string
}): Promise<string> {
  const { page, spec, scenario, root = packageRoot() } = params
  const path = evidencePath({ spec, scenario }, root)
  ensureDir(path)
  await page.screenshot({ path })
  return path
}

async function decodeRaw(path: string) {
  return sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
}

/**
 * Exact per-channel byte compare via `sharp`, with no anti-aliasing tolerance: the shifts
 * this must catch (a rail dot moving a few pixels) are what fuzzy differs ignore.
 *
 * In the diff image, differing pixels are solid red; matching pixels are the golden at low
 * alpha for context.
 */
export async function comparePng(
  actualPath: string,
  goldenPath: string,
  options: ComparePngOptions = {},
): Promise<PixelDiffResult> {
  const [golden, actual] = await Promise.all([decodeRaw(goldenPath), decodeRaw(actualPath)])

  const requestedDiffPath = options.diffPath === undefined ? defaultDiffPath(actualPath) : options.diffPath

  if (
    golden.info.width !== actual.info.width ||
    golden.info.height !== actual.info.height
  ) {
    // Dimension mismatch: `Infinity`/`1`, no pixel-aligned overlay is meaningful when
    // the shapes differ.
    return { diffPixels: Number.POSITIVE_INFINITY, diffRatio: 1, diffPath: null }
  }

  const { width, height, channels } = golden.info
  const pixelCount = width * height
  const diffBuffer = requestedDiffPath ? Buffer.alloc(pixelCount * 4) : null
  let diffPixels = 0

  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const srcOffset = pixel * channels
    let differs = false
    for (let channel = 0; channel < channels; channel++) {
      if (golden.data[srcOffset + channel] !== actual.data[srcOffset + channel]) {
        differs = true
        break
      }
    }
    if (differs) diffPixels++

    if (diffBuffer) {
      const dstOffset = pixel * 4
      if (differs) {
        diffBuffer[dstOffset] = 255
        diffBuffer[dstOffset + 1] = 0
        diffBuffer[dstOffset + 2] = 0
        diffBuffer[dstOffset + 3] = 255
      } else {
        diffBuffer[dstOffset] = golden.data[srcOffset]
        diffBuffer[dstOffset + 1] = golden.data[srcOffset + 1]
        diffBuffer[dstOffset + 2] = golden.data[srcOffset + 2]
        diffBuffer[dstOffset + 3] = 64
      }
    }
  }

  let writtenDiffPath: string | null = null
  if (diffBuffer && requestedDiffPath) {
    ensureDir(requestedDiffPath)
    await sharp(diffBuffer, { raw: { width, height, channels: 4 } }).png().toFile(requestedDiffPath)
    writtenDiffPath = requestedDiffPath
  }

  return {
    diffPixels,
    diffRatio: diffPixels / pixelCount,
    diffPath: writtenDiffPath,
    width,
    height,
  }
}
