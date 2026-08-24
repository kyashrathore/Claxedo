import { afterEach, describe, expect, test } from "bun:test"
import { observeTimelineFileCandidates, timelineFileCandidateIsOpenable } from "./timeline-file-paths"

const DIR = "/Users/me/project"
const settleDom = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

afterEach(() => document.body.replaceChildren())

describe("timelineFileCandidateIsOpenable", () => {
  test("accepts an exact extensionless workspace file", async () => {
    expect(
      await timelineFileCandidateIsOpenable("packages/opencode/bin/opencode", DIR, async () => [
        "packages/opencode/bin/opencode",
      ]),
    ).toBe(true)
  })

  test("rejects directories and fuzzy-only file matches", async () => {
    expect(await timelineFileCandidateIsOpenable("packages/opencode", DIR, async () => [])).toBe(false)
    expect(await timelineFileCandidateIsOpenable("session/status", DIR, async () => ["src/session/status.ts"])).toBe(
      false,
    )
  })

  test("rejects traversal before searching", async () => {
    let searches = 0
    expect(
      await timelineFileCandidateIsOpenable("../shared/util.ts", DIR, async () => {
        searches += 1
        return ["../shared/util.ts"]
      }),
    ).toBe(false)
    expect(searches).toBe(0)
  })
})

describe("observeTimelineFileCandidates", () => {
  test("promotes exact initial and inserted candidates only", async () => {
    const root = document.createElement("div")
    const initial = candidate("bin/tool")
    root.append(initial)
    document.body.append(root)

    const stop = observeTimelineFileCandidates(root, DIR, async (query) => (query === "bin/tool" ? ["bin/tool"] : []))
    await settleDom()
    expect(initial.dataset.inlineCodeKind).toBe("path")

    const inserted = candidate("bin/missing")
    root.append(inserted)
    await settleDom()
    expect(inserted.dataset.inlineCodeKind).toBeUndefined()
    stop()
  })

  test("revalidates text replacements and ignores stale results", async () => {
    const root = document.createElement("div")
    const element = candidate("bin/old")
    root.append(element)
    document.body.append(root)
    const requests: string[] = []
    const resolvers = new Map<string, (files: readonly string[]) => void>()
    const stop = observeTimelineFileCandidates(
      root,
      DIR,
      (query) =>
        new Promise((resolve) => {
          requests.push(query)
          resolvers.set(query, resolve)
        }),
    )

    element.textContent = "bin/new"
    await settleDom()
    expect(requests).toEqual(["bin/old", "bin/new"])
    resolvers.get("bin/old")?.(["bin/old"])
    resolvers.get("bin/new")?.(["bin/new"])
    await settleDom()
    expect(element.dataset.inlineCodeKind).toBe("path")
    stop()
  })

  test("does not promote after cleanup or outside the observed root", async () => {
    const root = document.createElement("div")
    const outside = document.createElement("div")
    const moved = candidate("bin/moved")
    const stopped = candidate("bin/stopped")
    root.append(moved, stopped)
    document.body.append(root, outside)
    const resolvers = new Map<string, (files: readonly string[]) => void>()
    const stop = observeTimelineFileCandidates(
      root,
      DIR,
      (query) => new Promise((resolve) => resolvers.set(query, resolve)),
    )

    outside.append(moved)
    resolvers.get("bin/moved")?.(["bin/moved"])
    await settleDom()
    expect(moved.dataset.inlineCodeKind).toBe("path-candidate")

    stop()
    resolvers.get("bin/stopped")?.(["bin/stopped"])
    root.append(candidate("bin/after-stop"))
    await settleDom()
    expect(stopped.dataset.inlineCodeKind).toBe("path-candidate")
    expect(resolvers.has("bin/after-stop")).toBe(false)
  })

  test("bounds concurrent and queued distinct searches", () => {
    const root = document.createElement("div")
    root.append(...Array.from({ length: 300 }, (_, index) => candidate(`bin/tool-${index}`)))
    document.body.append(root)
    let searches = 0
    const stop = observeTimelineFileCandidates(root, DIR, () => {
      searches += 1
      return new Promise(() => {})
    })

    expect(searches).toBe(8)
    stop()
  })
})

function candidate(text: string) {
  const element = document.createElement("code")
  element.dataset.inlineCodeKind = "path-candidate"
  element.textContent = text
  return element
}
