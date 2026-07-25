/**
 * GUARD: every Playwright spec is reachable from some suite lane.
 *
 * WHY THIS EXISTS — Playwright selects specs by `grep`ping the test title, and
 * `playwright.config.ts` maps `CLAXEDO_E2E_SUITE` to exactly one tag regex per lane. A
 * spec whose title carries no recognised lane tag is therefore selected by NO lane and
 * silently never runs, while still looking like a passing part of the suite. That is not
 * hypothetical: `a11y-sweep.spec.ts` was tagged `@happy` — a dead pre-consolidation lane
 * that no npm script and no CI job selects — so the accessibility regression net went
 * unexecuted in the only lane anyone watches. A typo (`@cores`) or a new spec authored
 * with no tag at all fails the same silent way. This guard makes that failure loud.
 *
 * WHAT IT ASSERTS —
 *   1. LANE_TAGS matches the lane registry actually compiled into
 *      `playwright.config.ts`, so adding a suite there without teaching this guard is a
 *      failure rather than a hole.
 *   2. Every `e2e/playwright/*.spec.ts` carries at least one LANE_TAG in a
 *      `test.describe(...)`/`test(...)` title.
 *   3. Every `@tag` appearing in any test title is a LANE_TAG, a SUB_SELECTOR_TAGS
 *      entry, or the carve-out tag — so a misspelled tag cannot masquerade as a lane.
 *
 * DELIBERATE EXEMPTION — `deployed-workgraph.spec.ts` is `testIgnore`d by
 * `playwright.config.ts` and owned by `playwright.deployed.config.ts`, so it has no lane
 * by design (see the LANE note in that file). It is the only exemption; adding another
 * means adding another config, not another untagged spec.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const appRoot = path.resolve(import.meta.dir, "../..")
const specDir = path.join(appRoot, "e2e/playwright")
const configPath = path.join(appRoot, "playwright.config.ts")

/**
 * Lane tags: a spec must carry one of these or no lane will ever select it. Keep in
 * sync with the `suiteGrep` registry in `playwright.config.ts` (assertion 1 enforces it).
 * `all` is a lane with no tag filter, so it contributes no tag here.
 */
const LANE_TAGS = ["@core", "@live", "@marketing"] as const

/**
 * Tags that refine a selection *within* a lane rather than granting one. A spec may
 * carry these, but never *only* these.
 *   `@workgraph-real` — carved out of the sharded core lane by `test:e2e:core:base`'s
 *     `--grep-invert`, run by the separate `e2e (workgraph-real)` CI job.
 *   `@documents-*-canary` — release-canary selectors used by the `test:e2e:documents:*`
 *     scripts to run a subset of an already-laned spec.
 */
const SUB_SELECTOR_TAGS = [
  "@workgraph-real",
  "@documents-release-canary",
  "@documents-rich-canary",
  "@documents-unsigned-local-canary",
  "@documents-rich-live-canary",
] as const

/** Owned by `playwright.deployed.config.ts`; `testIgnore`d by the main config. */
const UNLANED_BY_DESIGN = ["deployed-workgraph.spec.ts"] as const

const specFiles = readdirSync(specDir)
  .filter((file) => file.endsWith(".spec.ts"))
  .sort()

/**
 * Tags as Playwright sees them: only text inside a `test(...)`/`test.describe(...)`
 * title argument. Scanning whole files would false-positive on npm scopes
 * (`@playwright/test`, `@axe-core/playwright`) and on prose in the SPEC headers.
 */
const TITLE = /\btest(?:\.describe)?(?:\.serial|\.only|\.fixme|\.skip|\.parallel)*\(\s*(["'`])([\s\S]*?)\1/g
const TAG = /@[A-Za-z0-9][A-Za-z0-9_-]*/g

function tagsIn(file: string): string[] {
  const text = readFileSync(path.join(specDir, file), "utf8")
  const found = new Set<string>()
  for (const match of text.matchAll(TITLE)) for (const tag of match[2].match(TAG) ?? []) found.add(tag)
  return [...found].sort()
}

describe("e2e suite lane tags", () => {
  test("spec files exist to guard", () => {
    // A rename of testDir must not turn this guard into a silent no-op.
    expect(specFiles.length).toBeGreaterThan(20)
  })

  test("LANE_TAGS matches the suite registry in playwright.config.ts", () => {
    const config = readFileSync(configPath, "utf8")
    const registry = config.match(/const suiteGrep = \{([\s\S]*?)\n\} satisfies/)
    expect(registry, "playwright.config.ts must declare a `const suiteGrep = { ... } satisfies` lane registry").not.toBeNull()
    const configured = [...(registry?.[1].match(/\/(@[A-Za-z0-9_-]+)\//g) ?? [])].map((tag) => tag.replaceAll("/", "")).sort()
    expect(configured).toEqual([...LANE_TAGS].sort())
  })

  test("every spec carries a recognised lane tag", () => {
    const offenders = specFiles.flatMap((file) => {
      if ((UNLANED_BY_DESIGN as readonly string[]).includes(file)) return []
      const tags = tagsIn(file)
      if (tags.some((tag) => (LANE_TAGS as readonly string[]).includes(tag))) return []
      return [
        `${file}: has ${tags.length ? `only ${tags.join(" ")}` : "no tags"} — no CLAXEDO_E2E_SUITE lane ` +
          `selects it, so it never runs. Add one of ${LANE_TAGS.join(" / ")} to its test.describe title.`,
      ]
    })

    expect(offenders).toEqual([])
  })

  test("no spec carries an unrecognised tag", () => {
    const known = new Set<string>([...LANE_TAGS, ...SUB_SELECTOR_TAGS])
    const offenders = specFiles.flatMap((file) =>
      tagsIn(file)
        .filter((tag) => !known.has(tag))
        .map((tag) => `${file}: unknown tag ${tag} — typo, or a new tag that must be registered in this guard.`),
    )

    expect(offenders).toEqual([])
  })

  test("the dead @happy lane stays dead", () => {
    // `@happy` predates the 25-spec consolidation and survives only in the retired
    // `e2e-legacy/` tree (outside Playwright's testDir). Two specs inherited it by
    // copy-paste and vanished from CI. Re-introducing it re-introduces that bug.
    const offenders = specFiles.filter((file) => tagsIn(file).includes("@happy"))
    expect(offenders).toEqual([])
  })
})
