import { describe, expect, test } from "bun:test"
import {
  absorbChecks,
  addEntry,
  addOwner,
  announcementPrompt,
  bumpVersion,
  changelogMarkdown,
  conventionalCommits,
  createRelease,
  defaultReleaseDate,
  GATED_STAGES,
  nextVersion,
  openBlockers,
  overallProgress,
  parseVersion,
  removeEntry,
  ship,
  stageItems,
  stageProgress,
  startNextRelease,
  suggestedBump,
  type Release,
} from "./model"

const NOW = new Date(2026, 9, 18, 12).getTime()

function checkAll(release: Release, predicate: (blocking: boolean) => boolean): Release {
  const view = release.stages.map((stage) => ({
    groups: stage.groups.map((group) => ({ items: group.items.map((item) => ({ id: item.id, done: predicate(item.blocking) })) })),
  }))
  return absorbChecks(release, view)
}

function withEntries(release: Release): Release {
  let next = release
  for (const [type, scope, description] of [
    ["feat", "sessions", "Resume sessions after a restart"],
    ["fix", "", "Keep the cursor when the editor reloads"],
    ["chore", "deps", "Update the bundler"],
    ["feat", "", "Dark mode for the release page"],
  ] as const) {
    const change = addEntry(next, type, scope, description)
    if (change.error) throw new Error(change.error)
    next = change.release
  }
  return next
}

describe("semver", () => {
  test("parses major.minor.patch with an optional v and rejects anything else", () => {
    expect(parseVersion("v1.4.3")).toEqual({ major: 1, minor: 4, patch: 3 })
    expect(parseVersion("1.4")).toBeNull()
    expect(parseVersion("01.2.3")).toBeNull()
    expect(parseVersion("1.2.3-beta")).toBeNull()
  })

  test("each bump resets the lower parts", () => {
    expect(bumpVersion("1.4.3", "major")).toBe("2.0.0")
    expect(bumpVersion("1.4.3", "minor")).toBe("1.5.0")
    expect(bumpVersion("1.4.3", "patch")).toBe("1.4.4")
    expect(() => bumpVersion("next", "patch")).toThrow(/not a major.minor.patch/)
  })

  test("the suggested bump follows the changelog", () => {
    const release = createRelease()
    expect(suggestedBump(release.changelog)).toBe("patch")
    expect(suggestedBump(withEntries(release).changelog)).toBe("minor")
    const breaking = addEntry(release, "fix", "api", "BREAKING: drop the v1 endpoint").release
    expect(suggestedBump(breaking.changelog)).toBe("major")
  })
})

describe("checklists", () => {
  test("a new release starts with every stage unchecked", () => {
    const release = createRelease()
    expect(release.stages.map((stage) => stage.id)).toEqual(["prepare", "verify", "ship", "announce"])
    expect(overallProgress(release.stages).done).toBe(0)
    expect(overallProgress(release.stages).total).toBe(19)
  })

  test("absorbing the page's checklist updates only items it names", () => {
    const release = createRelease()
    const prepare = release.stages[0]
    if (!prepare) throw new Error("no prepare stage")
    const first = stageItems(prepare)[0]
    if (!first) throw new Error("no item")
    const absorbed = absorbChecks(release, [{ groups: [{ items: [{ id: first.id, done: true }, { id: "unknown", done: true }] }] }])
    expect(stageProgress(absorbed.stages[0] ?? prepare)).toEqual({ done: 1, total: 5, percent: 20 })
    expect(overallProgress(absorbed.stages).done).toBe(1)
    expect(absorbChecks(release, null)).toBe(release)
  })

  test("blockers are the unchecked blocking items of the gated stages", () => {
    const release = createRelease()
    const blockers = openBlockers(release)
    const gatedBlocking = release.stages
      .filter((stage) => GATED_STAGES.includes(stage.id))
      .flatMap(stageItems)
      .filter((item) => item.blocking)
    expect(blockers).toHaveLength(gatedBlocking.length)
    expect(blockers[0]).toEqual({ stage: "Prepare", label: "Cut the release branch from main" })
    expect(openBlockers(checkAll(release, (blocking) => blocking))).toHaveLength(0)
  })
})

describe("shipping", () => {
  test("ship refuses while blocking items are open and lists them", () => {
    const attempt = ship(createRelease("1.4.3", "2026-10-25T10:00"), NOW)
    expect(attempt.error).toMatch(/blocking items are still open/)
    expect(attempt.blockers.map((blocker) => blocker.label)).toContain("Full test suite is green")
    expect(attempt.release.shipped).toBeNull()
  })

  test("ship refuses without a release date", () => {
    const release = checkAll(createRelease("1.4.3", ""), () => true)
    expect(ship(release, NOW).error).toMatch(/release date/)
  })

  test("with blockers done, ship records the next version and makes it current", () => {
    const ready = { ...checkAll(createRelease("1.4.3", "2026-10-25T10:00"), (blocking) => blocking), bump: "major" as const }
    const shipped = ship(ready, NOW)
    expect(shipped.error).toBeUndefined()
    expect(shipped.release.shipped).toEqual({ version: "2.0.0", releaseDate: "2026-10-25T10:00", shippedAt: NOW })
    expect(shipped.release.currentVersion).toBe("2.0.0")
    expect(ship(shipped.release, NOW).error).toMatch(/already shipped/)
  })

  test("the next release keeps the version and owners but clears checks and changelog", () => {
    const shipped = ship(withEntries(checkAll(createRelease("1.4.3", "2026-10-25T10:00"), () => true)), NOW).release
    const next = startNextRelease(shipped)
    expect(next.currentVersion).toBe("1.5.0")
    expect(nextVersion(next)).toBe("1.6.0")
    expect(next.shipped).toBeNull()
    expect(next.changelog).toHaveLength(0)
    expect(overallProgress(next.stages).done).toBe(0)
    expect(next.owners).toEqual(shipped.owners)
  })
})

describe("changelog", () => {
  test("entries are validated", () => {
    const release = createRelease()
    expect(addEntry(release, "docs", "", "x").error).toMatch(/feat, fix or chore/)
    expect(addEntry(release, "fix", "", "  ").error).toMatch(/Describe/)
    expect(addEntry(release, "fix", "Bad Scope!", "x").error).toMatch(/scope/)
    expect(addEntry(release, "fix", " API ", "x").release.changelog[0]?.scope).toBe("api")
  })

  test("markdown groups entries by type in feat, fix, chore order under the target version", () => {
    const markdown = changelogMarkdown({ ...withEntries(createRelease("1.4.3", "2026-10-25T10:00")) })
    expect(markdown).toBe(
      [
        "## v1.5.0 (2026-10-25)",
        "### Features\n\n- **sessions:** Resume sessions after a restart\n- Dark mode for the release page",
        "### Fixes\n\n- Keep the cursor when the editor reloads",
        "### Chores\n\n- **deps:** Update the bundler",
      ].join("\n\n"),
    )
    expect(changelogMarkdown(createRelease())).toBe("## v1.5.0 (unscheduled)\n\n_No entries yet._")
  })

  test("conventional commit lines carry the scope in parentheses", () => {
    const release = withEntries(createRelease())
    expect(conventionalCommits(release.changelog).split("\n")).toEqual([
      "feat(sessions): Resume sessions after a restart",
      "fix: Keep the cursor when the editor reloads",
      "chore(deps): Update the bundler",
      "feat: Dark mode for the release page",
    ])
    const first = release.changelog[0]
    if (!first) throw new Error("no entry")
    expect(removeEntry(release, first.id).changelog).toHaveLength(3)
  })

  test("the announcement prompt carries the version, date, changelog and owners", () => {
    const prompt = announcementPrompt(withEntries(createRelease("1.4.3", "2026-10-25T10:00")))
    expect(prompt).toContain("release v1.5.0, going out on 2026-10-25 at 10:00")
    expect(prompt).toContain("- **sessions:** Resume sessions after a restart")
    expect(prompt).toContain("- Marco, QA lead (Verify)")
  })
})

describe("owners and dates", () => {
  test("owners need a name, a role and a stage", () => {
    const release = createRelease()
    expect(addOwner(release, "", "QA", "verify").error).toMatch(/name and a role/)
    expect(addOwner(release, "Lee", "QA", "deploy").error).toMatch(/stage/)
    expect(addOwner(release, " Lee ", "Docs", "announce").release.owners.at(-1)).toEqual({ id: "owner-4", name: "Lee", role: "Docs", stage: "announce" })
  })

  test("the default release date is a week out at 10:00 local time", () => {
    expect(defaultReleaseDate(NOW)).toBe("2026-10-25T10:00")
  })
})
