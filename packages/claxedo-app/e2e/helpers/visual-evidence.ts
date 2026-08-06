// Visual pipeline, mechanical half — Phase 5 of
// `docs/plans/2026-08-06-001-test-full-matrix-real-e2e-plan.md`. This module owns exactly
// two primitives: writing evidence PNGs to the path `e2e/INVARIANTS.md` already mandates
// (rule #2: "Every oracle assertion produces evidence ... into a per-run evidence
// directory (`test-results/evidence/<spec>/<scenario>.png`)"), and diffing two PNGs by
// raw pixel bytes with no AI involved. Judgement (which diffs are "broken", when to
// escalate to a vision reviewer) lives one layer up, in `scripts/visual-adjudicate.ts` —
// keeping that split is what lets the owner's constraint hold: "AI screenshot judgement
// must not slow the loop" (plan, owner decision 4). A pixel-exact match never talks to an
// adjudicator at all; only a non-zero diff does.
//
// Path convention duplicated from `e2e/helpers/turn-oracle.ts:51-55`'s `evidencePath`
// (there marked `_evidencePathForTest`, i.e. not a public contract) rather than imported
// from it — this file's owner is disjoint from turn-oracle.ts's per the plan's "Execution:
// parallelize with agents & workflows" section (Phase 1 oracles vs Phase 5, independent
// files, no shared edits). Both must resolve to the SAME path shape because
// `desktop-unsigned-embedded.spec.ts` and friends already write assistant-reply evidence
// through turn-oracle.ts's copy; a rail/geometry oracle calling `captureEvidence` here for
// a non-turn scenario must land in the same `<spec>/<scenario>.png` tree so one CLI
// (`visual-adjudicate.ts`) can walk both without a spec-specific case.
//
// Goldens are NOT evidence — evidence is the per-run, gitignored artifact
// (`test-results/` is `.gitignore`d at the repo root, unqualified, so it's ignored at any
// depth including `packages/claxedo-app/test-results/`); a golden is the checked-in
// reference image a run's evidence is diffed against, and lives under `e2e/goldens/`
// (tracked in git, sibling to the spec files whose scenarios it baselines) so it survives
// between runs and reviews as a normal source-controlled file.
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
   * anti-aliasing tolerance, same discipline as the existing pixel-diff in
   * `scripts/capture-p4-named-surfaces.ts:632-639` (`comparePixelDiff`), which this
   * function's inner loop mirrors on purpose rather than diverging on style. `Infinity`
   * means the two images aren't even the same dimensions — same convention as that
   * function's line 625, `pixelDiffCount: Number.POSITIVE_INFINITY` for a size mismatch. */
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
   * `scripts/visual-adjudicate.ts`'s zero-diff branch). */
  diffPath?: string | null
}

/**
 * `e2e/helpers/turn-oracle.ts:63-65`'s `packageRoot()`, duplicated rather than imported —
 * see the file-header note on why these two modules don't share edits. Correct when
 * Playwright/the CLI is invoked from `packages/claxedo-app`, the documented-only
 * invocation directory (same assumption turn-oracle.ts makes).
 */
function packageRoot() {
  return process.cwd()
}

function ensureDir(filePath: string) {
  mkdirSync(dirname(filePath), { recursive: true })
}

/** `test-results/evidence/<spec>/<scenario>.png` — `e2e/INVARIANTS.md` rule #2, verbatim. */
export function evidencePath(evidence: Evidence, root: string = packageRoot()): string {
  return join(root, "test-results", "evidence", evidence.spec, `${evidence.scenario}.png`)
}

/** The checked-in reference image a run's evidence is diffed against. Not gitignored
 * (unlike `evidencePath`'s `test-results/` tree) — a golden is a source-controlled
 * artifact, updated deliberately (`scripts/visual-adjudicate.ts --update-goldens`), never
 * a byproduct of running the suite. */
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
 * `scripts/visual-adjudicate.ts` skips `*.diff.png` and any stray non-PNG file (verdict
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
 * Writes the evidence PNG for one scenario. This is the general-purpose sibling of
 * `turn-oracle.ts`'s private `captureEvidence` (turn-oracle.ts:160-164, which the Oracle
 * calls internally for assistant-reply proofs only) — other oracles (rail, geometry,
 * surface-parity) that want a screenshot at their assertion point call THIS one directly,
 * so every scenario's evidence lands in the same tree regardless of which oracle produced
 * it. Returns the absolute path written, same shape turn-oracle.ts's version returns.
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
 * Pure pixel diff — no AI, no perceptual/anti-aliasing tolerance, decode via `sharp`
 * (already a devDependency, used identically by
 * `scripts/capture-p4-named-surfaces.ts:531,616-617` and
 * `e2e/playwright/core-terminal.spec.ts:679`; no new dependency added). Exact per-channel
 * byte compare, same as `capture-p4-named-surfaces.ts`'s `comparePixelDiff` — deliberately
 * NOT a perceptual/fuzzy diff (no pixelmatch-style anti-aliasing detection), because the
 * load-bearing case this exists for (defect 11: the rail dot moving a handful of pixels)
 * is exactly the kind of small, precise shift a fuzzy/AA-tolerant differ is tuned to
 * ignore.
 *
 * When a diff image is written, differing pixels are painted solid red at full alpha;
 * matching pixels are copied through at low alpha (a dim "ghost" of the golden) so the
 * red highlights read against real context instead of a blank canvas.
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
    // Mirrors capture-p4-named-surfaces.ts:619-629's dimension-mismatch branch exactly —
    // `Infinity`/`1`, no pixel-aligned overlay is meaningful when the shapes differ.
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
