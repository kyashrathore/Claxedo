// Judgement half of the visual pipeline. `e2e/helpers/visual-evidence.ts` owns the
// mechanics (screenshot path, pixel-exact PNG diff); this CLI walks every scenario's
// evidence, diffs it against its checked-in golden, and writes a `visual_verified`
// verdict per scenario.
//
// A pixel-exact match never calls the adjudicator; only a non-zero diff escalates,
// and the adjudicator is a seam (`adjudicateWith`), not a live AI call, so this file
// has no network dependency.
//
// Usage (from packages/claxedo-app):
//   bun run e2e/visual-adjudicate.ts                  # diff; escalate non-zero diffs
//   bun run e2e/visual-adjudicate.ts --pr-loop        # diff only; non-zero = needs review
//   bun run e2e/visual-adjudicate.ts --update-goldens # copy current evidence over goldens
//
// Env overrides:
//   CLAXEDO_VISUAL_EVIDENCE_DIR   default <package>/test-results/evidence
//   CLAXEDO_VISUAL_GOLDEN_DIR     default <package>/e2e/goldens
import path from "node:path"
import { comparePng, parseEvidenceRelativePath, type Evidence } from "../e2e/helpers/visual-evidence"
import { readBoolean, readString } from "../src/lib/record"

const PACKAGE_DIR = path.resolve(import.meta.dir, "..")
const EVIDENCE_DIR = path.resolve(Bun.env.CLAXEDO_VISUAL_EVIDENCE_DIR ?? path.join(PACKAGE_DIR, "test-results/evidence"))
const GOLDEN_DIR = path.resolve(Bun.env.CLAXEDO_VISUAL_GOLDEN_DIR ?? path.join(PACKAGE_DIR, "e2e/goldens"))

const prLoop = process.argv.includes("--pr-loop")
const updateGoldens = process.argv.includes("--update-goldens")

// --- The escalation seam -----------------------------------------------------------
//
// A non-zero diff is handed here to answer "intended or broken?". Real vision wiring
// replaces the default via `adjudicateWith` or `--adjudicator <module>`.
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
 * Fails safe: an unwired adjudicator reports every escalated diff as not verified,
 * naming itself as the reason. Claiming "verified" for a diff nobody looked at would
 * be a false green.
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

/** Replaces the fail-safe default; exported so a caller can wire an adjudicator
 * programmatically instead of via `--adjudicator`. */
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
  // The module is loaded at runtime, so its signature cannot be checked here.
  // Wrap it: the adapter has the declared type, and a module that answers with
  // something other than a verdict fails loudly at its own call site rather
  // than silently reporting a diff as verified.
  adjudicateWith(async (request) => {
    const verdict: unknown = await candidate(request)
    const verified = readBoolean(verdict, "verified")
    const reason = readString(verdict, "reason")
    if (verified === undefined || reason === undefined) {
      throw new Error(`--adjudicator module ${resolved} did not return { verified, reason }`)
    }
    return { verified, reason }
  })
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

// Joined directly against the resolved dirs, not via `evidencePath`/`goldenPath` from
// visual-evidence.ts: those rebuild the default root-plus-suffix layout and would
// ignore the env overrides.
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
    // First run of a new scenario: no golden yet. Reported loudly but not a failure,
    // so adding a scenario is not a two-step ceremony.
    return { ...base, status: "no-golden" }
  }

  const diff = await comparePng(actual, golden)

  if (diff.diffPixels === 0) {
    return { ...base, status: "pixel-exact", diffPixels: 0, diffRatio: 0, diffPath: null, visual_verified: true }
  }

  if (prLoop) {
    // No AI call in the PR loop: a non-zero diff is left unverified rather than guessed at.
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
