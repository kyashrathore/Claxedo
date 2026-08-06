// Visual pipeline, judgement half — Phase 5 of
// `docs/plans/2026-08-06-001-test-full-matrix-real-e2e-plan.md`. `e2e/helpers/
// visual-evidence.ts` owns the mechanics (screenshot to the mandated path, pixel-exact
// PNG diff); this CLI owns deciding what those diffs MEAN. It walks every scenario's
// evidence, diffs it against its checked-in golden, and writes a `visual_verified`
// verdict per scenario — the verdict `e2e/INVARIANTS.md` rule #2 requires but has "never
// been automated" before this (plan, "Verified architecture facts": "`e2e/INVARIANTS.md`
// rule #1 already mandates vision-verified evidence and a separate `visual_verified`
// verdict. It has never been automated.").
//
// Owner constraint (plan, owner decision 4): "AI screenshot judgement must not slow the
// loop... Pixel-diff first; escalate to vision only on a non-zero diff, plus a nightly
// full sweep." This file is that decision, literally: a pixel-exact match (diffPixels
// === 0) NEVER calls the adjudicator below — the escalation only fires on a non-zero
// diff, and the escalation itself is a documented seam (`adjudicateWith`), not a live AI
// call, so this file has no network dependency and no added devDependency.
//
// Usage (run from packages/claxedo-app, same invocation-directory assumption as every
// other script in this directory — see e.g. capture-p4-named-surfaces.ts):
//   bun run scripts/visual-adjudicate.ts                 # sweep mode: diff, then
//                                                         #   escalate every non-zero
//                                                         #   diff to the wired adjudicator
//   bun run scripts/visual-adjudicate.ts --pr-loop        # diff only; a non-zero diff is
//                                                         #   reported as needing review,
//                                                         #   the adjudicator is never
//                                                         #   called (keeps the PR loop
//                                                         #   AI-latency-free per decision 4)
//   bun run scripts/visual-adjudicate.ts --update-goldens # no comparison: copy every
//                                                         #   scenario's current evidence
//                                                         #   over its golden (deliberate
//                                                         #   maintenance, never automatic)
//
// Env overrides (mirroring the CLAXEDO_P4_SURFACE_* convention in
// capture-p4-named-surfaces.ts):
//   CLAXEDO_VISUAL_EVIDENCE_DIR   default <package>/test-results/evidence
//   CLAXEDO_VISUAL_GOLDEN_DIR     default <package>/e2e/goldens
import path from "node:path"
import { comparePng, parseEvidenceRelativePath, type Evidence } from "../e2e/helpers/visual-evidence"

const PACKAGE_DIR = path.resolve(import.meta.dir, "..")
const EVIDENCE_DIR = path.resolve(Bun.env.CLAXEDO_VISUAL_EVIDENCE_DIR ?? path.join(PACKAGE_DIR, "test-results/evidence"))
const GOLDEN_DIR = path.resolve(Bun.env.CLAXEDO_VISUAL_GOLDEN_DIR ?? path.join(PACKAGE_DIR, "e2e/goldens"))

const prLoop = process.argv.includes("--pr-loop")
const updateGoldens = process.argv.includes("--update-goldens")

// --- The escalation seam -----------------------------------------------------------
//
// A non-zero diff is handed here to answer "intended or broken?" (plan, Phase 5: "A
// non-zero diff escalates to an AI vision adjudication that answers 'intended or
// broken?' and writes visual_verified."). This is a FUNCTION, not a network call — real
// vision integration wires a replacement in via `adjudicateWith` (or `--adjudicator
// <module>` below); nothing here reaches out to a model itself, which is what keeps this
// file dependency-free and keeps a `--pr-loop` run's latency at "read some PNGs" instead
// of "wait on an API".
export type VisualAdjudicationRequest = {
  spec: string
  scenario: string
  actualPath: string
  goldenPath: string
  diffPath: string | null
  diffPixels: number
  diffRatio: number
}

export type VisualAdjudicationVerdict = {
  verified: boolean
  reason: string
}

export type VisualAdjudicator = (request: VisualAdjudicationRequest) => Promise<VisualAdjudicationVerdict>

/**
 * Fails safe: an unwired adjudicator reports every escalated diff as NOT verified,
 * naming itself as the reason. A stub that instead claimed "verified" for a diff nobody
 * actually looked at would be exactly the false-green failure mode
 * `e2e/INVARIANTS.md` rule #1 exists to forbid ("Nothing is 'done' because tests pass") —
 * see project memory `feedback_no_false_positive_verification.md`. Real wiring replaces
 * this via `adjudicateWith`/`--adjudicator`; until it does, every non-zero diff is loud.
 */
export const unwiredAdjudicator: VisualAdjudicator = async (request) => ({
  verified: false,
  reason:
    `no vision adjudicator wired — diffPixels=${request.diffPixels} ` +
    `(${(request.diffRatio * 100).toFixed(3)}% of pixels) requires manual or AI review ` +
    `before "${request.spec}/${request.scenario}" can be marked visual_verified. ` +
    `Wire a real adjudicator via adjudicateWith() or --adjudicator <module>.`,
})

let adjudicator: VisualAdjudicator = unwiredAdjudicator

/**
 * The documented escalation hook (plan, Phase 5: "The escalation hook may be a
 * documented seam (a function others call) rather than a live AI call."). A nightly
 * sweep wiring, or a future live vision integration, calls this once at startup to
 * replace the fail-safe default above. Exported so a caller can `import` this module and
 * wire it programmatically instead of going through `--adjudicator`.
 */
export function adjudicateWith(next: VisualAdjudicator) {
  adjudicator = next
}

async function loadAdjudicatorFromArg() {
  const flagIndex = process.argv.indexOf("--adjudicator")
  if (flagIndex === -1) return
  const modulePath = process.argv[flagIndex + 1]
  if (!modulePath) {
    console.error("--adjudicator requires a module path argument")
    process.exit(2)
  }
  const resolved = path.isAbsolute(modulePath) ? modulePath : path.resolve(PACKAGE_DIR, modulePath)
  const mod = await import(resolved)
  const candidate = mod.default ?? mod.adjudicate
  if (typeof candidate !== "function") {
    console.error(`--adjudicator module ${resolved} has no default export or named "adjudicate" export`)
    process.exit(2)
  }
  adjudicateWith(candidate as VisualAdjudicator)
}

// --- Walking evidence ----------------------------------------------------------------

type ScenarioResult = {
  spec: string
  scenario: string
  status: "pixel-exact" | "escalated" | "needs-review" | "no-golden" | "golden-updated" | "error"
  diffPixels?: number
  diffRatio?: number
  diffPath?: string | null
  visual_verified?: boolean
  reason?: string
}

// Deliberately NOT `evidencePath`/`goldenPath` from visual-evidence.ts — those assume
// the DEFAULT layout (`<root>/test-results/evidence/...`, `<root>/e2e/goldens/...`) for
// specs that don't override it. This CLI's `CLAXEDO_VISUAL_EVIDENCE_DIR`/
// `CLAXEDO_VISUAL_GOLDEN_DIR` env overrides (used by CI to redirect to an artifact dir,
// and by this file's own manual verification against a scratch fixture dir) can point
// anywhere, so paths are joined directly against the resolved `EVIDENCE_DIR`/
// `GOLDEN_DIR` instead of re-deriving a root-plus-fixed-suffix path that would silently
// ignore the override. Caught by hand: an early version of this file called
// `evidencePath(evidence, PACKAGE_DIR)` here, which reconstructed the DEFAULT path even
// when `CLAXEDO_VISUAL_EVIDENCE_DIR` pointed elsewhere — every scenario came back
// "no-golden" against a scratch fixture dir that plainly had goldens sitting in it.
function actualPathFor(evidence: Evidence): string {
  return path.join(EVIDENCE_DIR, evidence.spec, `${evidence.scenario}.png`)
}

function goldenPathFor(evidence: Evidence): string {
  return path.join(GOLDEN_DIR, evidence.spec, `${evidence.scenario}.png`)
}

async function discoverEvidence(): Promise<Evidence[]> {
  const found: Evidence[] = []
  const glob = new Bun.Glob("**/*.png")
  for await (const relative of glob.scan({ cwd: EVIDENCE_DIR })) {
    const parsed = parseEvidenceRelativePath(relative)
    if (parsed) found.push(parsed)
  }
  return found
}

async function adjudicateScenario(evidence: Evidence): Promise<ScenarioResult> {
  const actual = actualPathFor(evidence)
  const golden = goldenPathFor(evidence)
  const base = { spec: evidence.spec, scenario: evidence.scenario }

  if (updateGoldens) {
    await Bun.write(golden, await Bun.file(actual).arrayBuffer())
    return { ...base, status: "golden-updated" }
  }

  if (!(await Bun.file(golden).exists())) {
    // Bootstrap state, not a failure — the very first run of a new scenario has no
    // golden to compare against yet. Reported loudly (see the report/exit-code section
    // below) so it can't be silently forgotten, but doesn't fail the run: forcing every
    // brand-new scenario through `--update-goldens` before it can pass would make adding
    // a scenario a two-step ceremony instead of "write the test".
    return { ...base, status: "no-golden" }
  }

  const diff = await comparePng(actual, golden)

  if (diff.diffPixels === 0) {
    return { ...base, status: "pixel-exact", diffPixels: 0, diffRatio: 0, diffPath: null, visual_verified: true }
  }

  if (prLoop) {
    // Owner decision 4, literally: no AI call in the PR loop. A non-zero diff here is
    // surfaced as needing review — deliberately left unverified rather than guessed at,
    // same "don't claim what wasn't checked" doctrine as the unwired adjudicator above.
    return {
      ...base,
      status: "needs-review",
      diffPixels: diff.diffPixels,
      diffRatio: diff.diffRatio,
      diffPath: diff.diffPath,
      visual_verified: false,
      reason: "--pr-loop mode: non-zero diff, AI escalation skipped by design; review before merge or re-run without --pr-loop",
    }
  }

  const verdict = await adjudicator({
    spec: evidence.spec,
    scenario: evidence.scenario,
    actualPath: actual,
    goldenPath: golden,
    diffPath: diff.diffPath,
    diffPixels: diff.diffPixels,
    diffRatio: diff.diffRatio,
  })

  return {
    ...base,
    status: "escalated",
    diffPixels: diff.diffPixels,
    diffRatio: diff.diffRatio,
    diffPath: diff.diffPath,
    visual_verified: verdict.verified,
    reason: verdict.reason,
  }
}

async function writeVerdict(result: ScenarioResult) {
  const dir = path.join(EVIDENCE_DIR, result.spec)
  await Bun.$`mkdir -p ${dir}`.quiet()
  const file = path.join(dir, `${result.scenario}.visual-verdict.json`)
  await Bun.write(file, JSON.stringify({ ...result, checkedAt: new Date().toISOString() }, null, 2) + "\n")
  return file
}

async function main() {
  await loadAdjudicatorFromArg()

  const scenarios = await discoverEvidence()
  if (scenarios.length === 0) {
    console.log(`no evidence found under ${EVIDENCE_DIR} — run the suite first`)
    return
  }

  const results: ScenarioResult[] = []
  for (const evidence of scenarios) {
    try {
      const result = await adjudicateScenario(evidence)
      await writeVerdict(result)
      results.push(result)
    } catch (error) {
      results.push({
        spec: evidence.spec,
        scenario: evidence.scenario,
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  console.log(`\nvisual-adjudicate — ${prLoop ? "pr-loop (diff-only)" : "sweep"} mode, ${results.length} scenario(s)`)
  console.table(
    results.map((result) => ({
      scenario: `${result.spec}/${result.scenario}`,
      status: result.status,
      diffPixels: result.diffPixels ?? "-",
      diffRatio: result.diffRatio !== undefined ? `${(result.diffRatio * 100).toFixed(3)}%` : "-",
      visual_verified: result.visual_verified ?? "-",
    })),
  )

  const noGolden = results.filter((r) => r.status === "no-golden")
  if (noGolden.length) {
    console.warn(
      `\n${noGolden.length} scenario(s) have no golden yet (first run) — not a failure, but unverified:\n` +
        noGolden.map((r) => `  ${r.spec}/${r.scenario}`).join("\n") +
        `\nRun with --update-goldens once the evidence has been reviewed to baseline them.`,
    )
  }

  const broken = results.filter((r) => r.visual_verified === false)
  if (broken.length) {
    console.error(
      `\n${broken.length} scenario(s) failed visual verification:\n` +
        broken.map((r) => `  ${r.spec}/${r.scenario}: ${r.reason ?? "no reason recorded"}`).join("\n"),
    )
  }

  const errored = results.filter((r) => r.status === "error")
  if (errored.length) {
    console.error(
      `\n${errored.length} scenario(s) errored during adjudication:\n` +
        errored.map((r) => `  ${r.spec}/${r.scenario}: ${r.reason ?? "unknown error"}`).join("\n"),
    )
  }

  if (broken.length || errored.length) process.exit(1)
}

await main()
