import { describe, expect, test } from "bun:test"
import { absorbChecks, addEntry, createRelease, ship, type Release } from "./model"
import { changelogData, noticeMessages, releaseComponents, releaseData, stagesData } from "./view"

function checkBlocking(release: Release): Release {
  return absorbChecks(release, release.stages.map((stage) => ({ groups: stage.groups.map((group) => ({ items: group.items.map((item) => ({ id: item.id, done: item.blocking })) })) })))
}

describe("release summary", () => {
  test("an open release names the target, its blockers per stage and a warning tone", () => {
    const data = releaseData(createRelease("1.4.3", "2026-10-25T10:00"))
    expect(data.subtitle).toBe("v1.4.3 → v1.5.0 · minor bump · ships 2026-10-25 10:00")
    expect(data).toMatchObject({ status: "9 blocking open", tone: "warning" })
    expect(data.next).toEqual({ value: "v1.5.0", caption: "major 2.0.0 · minor 1.5.0 · patch 1.4.4" })
    expect(data.blockers).toEqual({ value: "9 open", caption: "Prepare 3 · Verify 4 · Ship 2" })
    expect(data.entries).toEqual({ value: "No entries", caption: "Suggests a patch bump" })
  })

  test("a ready release reads accent and a shipped one success", () => {
    const ready = checkBlocking(createRelease("1.4.3", "2026-10-25T10:00"))
    expect(releaseData(ready)).toMatchObject({ status: "Ready to ship", tone: "accent", blockers: { value: "None open" } })
    const shipped = ship(ready, 0).release
    expect(releaseData(shipped)).toMatchObject({ status: "Shipped", tone: "success", subtitle: "v1.5.0 shipped · release date 2026-10-25 10:00" })
  })
})

describe("rows", () => {
  test("each checklist item carries its kind as a word and a tone", () => {
    const release = createRelease()
    const [first, , third] = stagesData(release)[0]?.groups[0]?.items ?? []
    expect(first).toMatchObject({ label: "Cut the release branch from main", kind: "Blocking", tone: "warning", done: false })
    expect(third).toMatchObject({ kind: "Optional", tone: "neutral" })
    const cleared = stagesData(checkBlocking(release))[0]?.groups[0]
    expect(cleared?.items[0]).toMatchObject({ kind: "Cleared", tone: "success", done: true })
    expect(cleared?.progress).toBe("2 of 3 done")
  })

  test("changelog rows carry a type word, tone, icon and scope line", () => {
    const release = addEntry(addEntry(createRelease(), "feat", "ui", "New page").release, "fix", "", "Keep scroll").release
    const data = changelogData(release)
    expect(data.caption).toBe("2 entries for v1.5.0")
    expect(data.entries).toEqual([
      { id: "entry-4", description: "New page", scope: "Scope: ui", kind: "Feature", tone: "accent", icon: "star" },
      { id: "entry-5", description: "Keep scroll", scope: "No scope", kind: "Fix", tone: "success", icon: "check" },
    ])
  })
})

describe("structure", () => {
  test("a changelog row hides its one command behind a delete icon and the plan and checklist submit from footers", () => {
    const byId = new Map(releaseComponents(createRelease()).map((component) => [component.id, component]))
    expect(byId.get("entry-row")).toMatchObject({ actions: ["entry-remove"] })
    expect(byId.get("entry-remove")).toMatchObject({ component: "Button", icon: "delete" })
    expect(byId.get("plan")).toMatchObject({ child: "plan-body" })
    expect("actions" in (byId.get("plan") ?? {})).toBe(false)
    expect(byId.get("plan-footer")).toMatchObject({ component: "Footer", end: ["apply-bump"] })
    expect(byId.get("checklist-footer")).toMatchObject({ component: "Footer", end: ["save-progress"] })
  })
})

describe("notices", () => {
  test("a first notice adds the callout with its fix under the header, a repeat resends the callout only, a clear removes it", () => {
    const shown = noticeMessages("s", "ship", { title: "Not shipping: x", text: "y", action: "ship-retry" }, false)
    expect(shown[0]).toMatchObject({ updateDataModel: { path: "/notices/ship", value: { title: "Not shipping: x", text: "y" } } })
    const added = shown[1]
    if (!added || !("updateComponents" in added)) throw new Error("expected components")
    expect(added.updateComponents.components.map((component) => component.id)).toEqual(["root", "ship-notice"])
    expect(added.updateComponents.components[0]).toMatchObject({ children: ["header", "ship-notice", "kpis", "plan", "checklist", "changelog", "owners"] })
    expect(added.updateComponents.components[1]).toMatchObject({ tone: "danger", action: "ship-retry" })
    const repeat = noticeMessages("s", "ship", { title: "again", text: "", action: "ship-start-next" }, true)[1]
    if (!repeat || !("updateComponents" in repeat)) throw new Error("expected components")
    expect(repeat.updateComponents.components).toHaveLength(1)
    expect(repeat.updateComponents.components[0]).toMatchObject({ id: "ship-notice", action: "ship-start-next" })
    const cleared = noticeMessages("s", "ship", null, true)[0]
    if (!cleared || !("updateComponents" in cleared)) throw new Error("expected components")
    expect(cleared.updateComponents.components[0]).toMatchObject({ id: "root", children: ["header", "kpis", "plan", "checklist", "changelog", "owners"] })
    expect(noticeMessages("s", "entry", null, false)).toEqual([])
  })
})
